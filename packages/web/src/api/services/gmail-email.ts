import nodemailer from "nodemailer";
import { gmailConfiguration, gmailRelayConfiguration, gmailTransport } from "./email-config";
import type { EmailOutcome, SendEmailOptions } from "./email";

function transport(config: NonNullable<ReturnType<typeof gmailConfiguration>>) {
  return nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: config.user, pass: config.pass },
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 12_000,
    dnsTimeout: 8_000,
    logger: false, debug: false,
    disableFileAccess: true, disableUrlAccess: true,
  });
}

/** Return only stable codes. SMTP errors may contain credentials or message data. */
function safeFailure(error: unknown): EmailOutcome {
  const err = error && typeof error === "object" ? error as { code?: string; responseCode?: number } : {};
  const definite = err.code === "EAUTH" || err.code === "EENVELOPE" ||
    (typeof err.responseCode === "number" && err.responseCode >= 400 && err.responseCode < 600);
  return { outcome: definite ? "failed" : "unknown", providerId: null,
    code: definite ? "provider_rejected" : err.code === "ETIMEDOUT" ? "provider_timeout" : "provider_unconfirmed" };
}

export async function sendGmailEmail(options: SendEmailOptions): Promise<EmailOutcome> {
  const config = gmailConfiguration();
  if (!config) return { outcome: "failed", providerId: null, code: "sender_not_configured" };
  if (options.from && options.from !== config.from) return { outcome: "failed", providerId: null, code: "sender_changed" };
  // One concrete recipient only; no accidental address lists, headers, files or URLs.
  if (!/^[^\s<>(),;@]+@[^\s<>(),;@]+\.[^\s<>(),;@]+$/.test(options.to))
    return { outcome: "failed", providerId: null, code: "recipient_invalid" };
  if (gmailTransport() === "apps_script") return sendViaAppsScript(config.user, options);
  let smtp: ReturnType<typeof transport> | undefined;
  try {
    smtp = transport(config);
    const info = await smtp.sendMail({
      from: { name: "Steady", address: config.user },
      to: { address: options.to, name: "" },
      envelope: { from: config.user, to: [options.to] },
      subject: options.subject, text: options.text, html: options.html,
      disableFileAccess: true, disableUrlAccess: true,
    });
    // Message-ID is locally generated, NOT proof of SMTP acceptance on its own.
    const accepted = info.accepted?.some(address => address.toLowerCase() === options.to.toLowerCase());
    if (accepted && /^250[ -]/.test(info.response || ""))
      return { outcome: "accepted", providerId: info.messageId || null, code: "provider_accepted" };
    return { outcome: "unknown", providerId: null, code: "provider_unconfirmed" };
  } catch (error) { return safeFailure(error); }
  finally { smtp?.close(); }
}

/** Admin/operator use only. Authenticates, then quits. Sends no MAIL/RCPT/DATA. */
export async function verifyGmailConnection(): Promise<{ ok: boolean; code: string }> {
  const config = gmailConfiguration();
  if (!config) return { ok: false, code: "sender_not_configured" };
  let smtp: ReturnType<typeof transport> | undefined;
  try {
    smtp = transport(config);
    await smtp.verify();
    return { ok: true, code: "gmail_authenticated_no_email_sent" };
  } catch (error) { return { ok: false, code: safeFailure(error).code }; }
  finally { smtp?.close(); }
}

/**
 * HTTPS relay through a Google Apps Script web app owned by GMAIL_USER (see deploy/gmail-relay.gs).
 * The script sends with MailApp as that same Gmail account and reports which account sent it,
 * so the sender can never silently differ from GMAIL_USER. Same outcome contract as SMTP:
 * a definite refusal is "failed"; a timeout or unreadable reply is "unknown" and never replayed.
 */
async function sendViaAppsScript(user: string, options: SendEmailOptions): Promise<EmailOutcome> {
  const relay = gmailRelayConfiguration();
  if (!relay) return { outcome: "failed", providerId: null, code: "sender_not_configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(relay.url, {
      method: "POST", redirect: "follow", signal: controller.signal,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: relay.secret, to: options.to, subject: options.subject, text: options.text, html: options.html ?? "" }),
    });
    const data = await response.json().catch(() => null) as { ok?: unknown; id?: unknown; sender?: unknown; code?: unknown } | null;
    if (!data) return { outcome: "unknown", providerId: null, code: "provider_unconfirmed" };
    if (data.ok === true && typeof data.sender === "string" && data.sender.toLowerCase() === user)
      return { outcome: "accepted", providerId: typeof data.id === "string" ? data.id : null, code: "provider_accepted" };
    if (data.ok === true) return { outcome: "unknown", providerId: null, code: "sender_changed" };
    return { outcome: "failed", providerId: null, code: data.code === "unauthorized" ? "sender_not_configured" : "provider_rejected" };
  } catch {
    return { outcome: "unknown", providerId: null, code: controller.signal.aborted ? "provider_timeout" : "provider_unconfirmed" };
  } finally { clearTimeout(timer); }
}
