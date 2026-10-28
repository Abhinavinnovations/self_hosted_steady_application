/** Compatibility for managed-auth 0.4's Web Crypto RNG on Hermes.
 * Only installs the missing method. Never replaces an existing implementation,
 * never falls back to Math.random, and never changes the SDK's PKCE flow.
 */
export function installSecureRandom(
  target: { crypto?: { getRandomValues?: unknown } },
  fill: <T extends ArrayBufferView>(array: T) => T,
) {
  if (typeof target.crypto?.getRandomValues === "function") return;
  if (!target.crypto) Object.defineProperty(target, "crypto", { value: {}, configurable: true });
  Object.defineProperty(target.crypto, "getRandomValues", { value: fill, configurable: true, writable: true });
}

export type GoogleResult = { error?: { code?: string; message?: string } | null };
/** Explicit allowlist: provider responses/exception strings can contain private URLs. */
export function googleError(code?: string): string | null {
  if (code === "AUTH_SESSION_DISMISSED" || code === "POPUP_CLOSED") return null;
  const errors: Record<string, string> = {
    INVALID_CALLBACK: "Google returned an invalid sign-in response. Try again. [AUTH_CALLBACK]",
    EXCHANGE_FAILED: "Google sign-in could not finish. Check your connection and retry. [AUTH_EXCHANGE]",
    POPUP_BLOCKED: "Allow popups for Steady, then try Google again. [AUTH_POPUP]",
    POPUP_TIMEOUT: "Google sign-in timed out. Please try again. [AUTH_TIMEOUT]",
    GOOGLE_NOT_CONFIGURED: "Google sign-in isn't set up on this Steady server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). [AUTH_CONFIG]",
    UNSUPPORTED: "Google sign-in is available in the Android app. [AUTH_PLATFORM]",
  };
  return errors[code ?? ""] ?? "Google sign-in could not open or finish. Check your connection and default browser, then retry. [AUTH_START]";
}

/** Serial gate and finally cleanup are shared/testable, including synchronous throws. */
export function createGoogleAttempt() {
  let busy = false;
  return async (signIn: () => Promise<GoogleResult>, update: (loading: boolean, error: string | null) => void) => {
    if (busy) return;
    busy = true;
    update(true, null);
    let error: string | null = null;
    try { const result = await signIn(); error = result.error ? googleError(result.error.code) : null; }
    catch { error = googleError(); }
    finally { busy = false; update(false, error); }
  };
}
