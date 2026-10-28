import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { db } from "./database";
import { sendAccountVerification } from "./services/account-verification";

const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
export const googleConfigured = !!googleClientId && !!googleClientSecret;

export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: process.env.WEBSITE_URL,
  database: drizzleAdapter(db, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: sendAccountVerification,
  },
  // Self-hosted Google sign-in (replaces the Runable managed broker). Accounts
  // that previously signed in with Google are matched by their verified email,
  // so existing data stays attached to the same user.
  socialProviders: googleConfigured
    ? { google: { clientId: googleClientId!, clientSecret: googleClientSecret!, prompt: "select_account" } }
    : {},
  account: {
    accountLinking: { enabled: true, trustedProviders: ["google"] },
  },
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: (request) => {
    const origin = request?.headers.get("origin");
    const scheme = `${process.env.APP_SCHEME?.trim() || "steady"}://`;
    return origin ? [origin, scheme] : ["*", scheme];
  },
  // bearer(): the Android app authenticates with `Authorization: Bearer <token>`.
  plugins: [bearer(), expo()],
});
