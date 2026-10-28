import { createAuthClient } from "better-auth/react";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import * as Crypto from "expo-crypto";
import Constants from "expo-constants";
import type { GoogleResult } from "./auth-random";

const isWeb = Platform.OS === "web";
const TOKEN_KEY = "bearer_token";

const extra = Constants.expoConfig?.extra ?? {};
const baseURL: string = String(extra.apiUrl ?? process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/$/, "");

let cached: string | undefined;
export function getToken(): string {
  if (cached !== undefined) return cached;
  cached = (isWeb ? localStorage.getItem(TOKEN_KEY) : SecureStore.getItem(TOKEN_KEY)) ?? "";
  return cached;
}

function setToken(token: string) {
  cached = token;
  if (isWeb) localStorage.setItem(TOKEN_KEY, token);
  else SecureStore.setItem(TOKEN_KEY, token);
}

async function removeToken() {
  cached = "";
  if (isWeb) localStorage.removeItem(TOKEN_KEY);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export const authClient = createAuthClient({
  baseURL,
  basePath: "/api/auth",
  fetchOptions: {
    ...(isWeb ? { credentials: "omit" as const } : {}),
    auth: {
      type: "Bearer",
      token: () => getToken(),
    },
    headers: isWeb ? {} : { "expo-origin": "mobile://" },
  },
});

function base64url(base64: string) {
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Self-hosted Google sign-in (see packages/web/src/api/services/native-google.ts).
 * Opens Google in a Custom Tab via our own backend, receives a one-time PKCE-bound code on the
 * steady:// deep link, and exchanges it for this app's bearer session token.
 */
export async function signInWithGoogle(): Promise<GoogleResult> {
  if (isWeb) return { error: { code: "UNSUPPORTED", message: "Google sign-in is available in the Android app." } };
  const verifier = base64url(bytesToBase64(Crypto.getRandomBytes(32)));
  const challenge = base64url(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }));
  const redirect = Linking.createURL("auth/callback");
  const start = `${baseURL}/api/native-auth/google/start?${new URLSearchParams({ redirect, challenge })}`;

  const result = await WebBrowser.openAuthSessionAsync(start, redirect);
  if (result.type !== "success") return { error: { code: "AUTH_SESSION_DISMISSED" } };
  const params = Linking.parse(result.url).queryParams ?? {};
  const code = typeof params.code === "string" ? params.code : "";
  if (!code) return { error: { code: typeof params.error === "string" ? params.error : "INVALID_CALLBACK" } };

  try {
    const response = await fetch(`${baseURL}/api/native-auth/google/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier }),
    });
    const data = (await response.json()) as { token?: string };
    if (!response.ok || !data.token) return { error: { code: "EXCHANGE_FAILED" } };
    setToken(data.token);
  } catch {
    return { error: { code: "EXCHANGE_FAILED" } };
  }
  // Refresh useSession() without a reload.
  await authClient.getSession();
  authClient.$store.notify("$sessionSignal");
  return { error: null };
}

/** Call in onSuccess of signIn/signUp to capture the bearer token. */
export function captureToken(ctx: { response: Response }) {
  const token = ctx.response.headers.get("set-auth-token");
  if (token) setToken(token);
}

/** Clear stored token on sign-out. */
export async function clearToken() {
  await removeToken();
}
