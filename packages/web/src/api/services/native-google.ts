import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { auth, googleConfigured } from "../auth";
import { db } from "../database";
import { verification } from "../database/schema";

/**
 * Self-hosted Google sign-in for the native app (replaces the Runable managed broker).
 *
 * 1. App opens  GET  /api/native-auth/google/start?redirect=steady://auth/callback&challenge=<S256>
 *    in a Custom Tab. We start Better Auth's normal Google OAuth flow from there.
 * 2. Google -> /api/auth/callback/google (Better Auth) -> sets a session cookie in the Custom Tab
 *    -> redirects to /api/native-auth/google/finish.
 * 3. finish turns that session into a one-time code (2 min, single use, PKCE bound) and
 *    redirects to steady://auth/callback?code=...
 * 4. App POSTs code + verifier to /api/native-auth/google/exchange and receives its bearer token.
 */
const CODE_TTL_MS = 2 * 60 * 1000;
const scheme = () => process.env.APP_SCHEME?.trim() || "steady";
const origin = () => (process.env.WEBSITE_URL || "").replace(/\/$/, "");

function validRedirect(value: string | undefined): value is string {
  return !!value && value.startsWith(`${scheme()}://`) && value.length < 300 && !/[\s#]/.test(value);
}
const validChallenge = (value: string | undefined): value is string => !!value && /^[A-Za-z0-9_-]{43}$/.test(value);

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
async function s256(verifier: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
function randomCode() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
function backToApp(redirect: string, params: Record<string, string>) {
  const url = `${redirect}${redirect.includes("?") ? "&" : "?"}${new URLSearchParams(params)}`;
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
}

export function registerNativeGoogle(app: Hono) {
  app.get("/api/native-auth/google/start", async (c) => {
    const redirect = c.req.query("redirect");
    const challenge = c.req.query("challenge");
    if (!validRedirect(redirect) || !validChallenge(challenge)) return c.text("Invalid sign-in request", 400);
    if (!googleConfigured) return backToApp(redirect, { error: "GOOGLE_NOT_CONFIGURED" });

    const finish = `${origin()}/api/native-auth/google/finish?${new URLSearchParams({ redirect, challenge })}`;
    const response = await auth.api.signInSocial({
      body: { provider: "google", callbackURL: finish, errorCallbackURL: finish, disableRedirect: true },
      headers: c.req.raw.headers,
      asResponse: true,
    });
    const data = (await response.clone().json().catch(() => null)) as { url?: string } | null;
    if (!response.ok || !data?.url) return backToApp(redirect, { error: "EXCHANGE_FAILED" });

    // Carry Better Auth's OAuth state cookie(s) into the browser that follows the redirect.
    const headers = new Headers({ Location: data.url, "Cache-Control": "no-store" });
    for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  });

  app.get("/api/native-auth/google/finish", async (c) => {
    const redirect = c.req.query("redirect");
    const challenge = c.req.query("challenge");
    if (!validRedirect(redirect) || !validChallenge(challenge)) return c.text("Invalid sign-in request", 400);
    if (c.req.query("error")) return backToApp(redirect, { error: "INVALID_CALLBACK" });

    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    if (!session) return backToApp(redirect, { error: "INVALID_CALLBACK" });

    const code = randomCode();
    await db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: `native-google:${code}`,
      value: JSON.stringify({ token: session.session.token, challenge }),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    const res = backToApp(redirect, { code });
    // The Custom Tab doesn't need to keep a session of its own.
    for (const name of ["better-auth.session_token", "__Secure-better-auth.session_token", "better-auth.session_data", "__Secure-better-auth.session_data"])
      res.headers.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${name.startsWith("__Secure") ? "; Secure" : ""}`);
    return res;
  });

  app.post("/api/native-auth/google/exchange", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { code?: unknown; verifier?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code : "";
    const verifier = typeof body?.verifier === "string" ? body.verifier : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(code) || verifier.length < 43 || verifier.length > 128)
      return c.json({ error: "EXCHANGE_FAILED" }, 400);

    // Delete-and-return makes the code single use even under concurrent requests.
    const [row] = await db.delete(verification).where(eq(verification.identifier, `native-google:${code}`)).returning();
    if (!row || row.expiresAt.getTime() < Date.now()) return c.json({ error: "EXCHANGE_FAILED" }, 400);
    const stored = JSON.parse(row.value) as { token: string; challenge: string };
    if ((await s256(verifier)) !== stored.challenge) return c.json({ error: "EXCHANGE_FAILED" }, 400);
    return c.json({ token: stored.token }, 200);
  });
}
