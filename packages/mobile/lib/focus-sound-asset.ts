/** Fingerprint of the user-approved, peak-normalized MP3 (not a security signature). */
export const focusSoundFingerprint = { size: 49571, md5: "9806aa7b6d061b2c40a4acf7905d7927" };

export function focusSoundDownloadUri(uri: string) {
  const url = new URL(uri);
  if (url.protocol === "http:" && url.hostname.endsWith(".runable.site")) url.protocol = "https:";
  return url.toString();
}

export function validFocusSound(file: { exists: boolean; size: number; md5: string | null }) {
  return file.exists && file.size === focusSoundFingerprint.size && file.md5 === focusSoundFingerprint.md5;
}
