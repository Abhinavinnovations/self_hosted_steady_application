export type EmailProvider = "resend" | "gmail";

/** Explicit selection prevents a missing credential from silently changing provider. */
export function emailProvider(): EmailProvider | null {
  const value = process.env.EMAIL_PROVIDER?.trim() || "resend";
  return value === "gmail" || value === "resend" ? value : null;
}

/**
 * How Gmail mail leaves the server. "smtp" (default) uses smtp.gmail.com:465 with an App Password.
 * "apps_script" posts over HTTPS to a Google Apps Script web app running in the same Gmail
 * account, for hosts that block outbound SMTP (e.g. Render's free tier).
 */
export function gmailTransport(): "smtp" | "apps_script" {
  return process.env.GMAIL_TRANSPORT?.trim() === "apps_script" ? "apps_script" : "smtp";
}

export function gmailRelayConfiguration() {
  const url = process.env.GMAIL_RELAY_URL?.trim();
  const secret = process.env.GMAIL_RELAY_SECRET?.trim();
  if (!url || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) || !secret || secret.length < 24) return null;
  return { url, secret };
}

export function gmailConfiguration() {
  const user = process.env.GMAIL_USER?.trim().toLowerCase();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, "");
  const from = process.env.EMAIL_FROM?.trim();
  if (!user || !/^[a-z0-9._%+-]+@gmail\.com$/.test(user)) return null;
  if (gmailTransport() === "apps_script" ? !gmailRelayConfiguration() : !pass || !/^[a-z]{16}$/i.test(pass)) return null;
  // Gmail must send as the authenticated owner, never as an inviting app user.
  if (!from || ![user, `steady <${user}>`].includes(from.toLowerCase())) return null;
  return { user, pass: pass ?? "", from };
}

export function configuredEmailProvider() {
  const provider = emailProvider();
  if (provider === "gmail") return gmailConfiguration() ? provider : null;
  return provider === "resend" && process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim() ? provider : null;
}

/** SMTP cannot safely replay an uncertain send, even with the same Message-ID. */
export function canReplayEmail(provider: EmailProvider) {
  return provider === "resend" && emailProvider() === provider;
}
