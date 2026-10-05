import { describe, expect, test } from "bun:test";
import { createFocusCompletionCue, type CompletionSound } from "./focus-completion-cue";
import { focusSoundDownloadUri, focusSoundFingerprint, validFocusSound } from "./focus-sound-asset";

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function harness(initial = 2) {
  let plays = 0, releases = 0, prepares = 0;
  const ended = deferred<void>();
  const sound = { play: () => { plays++; return ended.promise; }, release: () => { releases++; } };
  const cue = createFocusCompletionCue(initial, async () => { prepares++; return sound; });
  return { cue, ended, state: () => ({ plays, releases, prepares }) };
}

describe("focus completion cue", () => {
  test("positive-to-zero plays once; repeats and save retries do not replay", async () => {
    const h = harness(); await flush();
    h.cue.tick(1); h.cue.tick(0); h.cue.tick(0); h.cue.tick(0); await flush();
    expect(h.state()).toEqual({ prepares: 1, plays: 1, releases: 0 });
    h.ended.resolve(); await flush(); expect(h.state().releases).toBe(1);
  });
  test("already-completed restore stays silent and does not preload", async () => {
    const h = harness(0); h.cue.tick(0); h.cue.dispose(); await flush();
    expect(h.state()).toEqual({ prepares: 0, plays: 0, releases: 0 });
  });
  test("pause has no tick; resume completes exactly once", async () => {
    const h = harness(30); await flush(); h.cue.tick(20); await flush();
    expect(h.state().plays).toBe(0);
    h.cue.tick(19); h.cue.tick(0); await flush(); expect(h.state().plays).toBe(1);
    h.ended.resolve(); await flush();
  });
  test("early stop/unmount prevents future playback and releases preload", async () => {
    const h = harness(); await flush(); h.cue.dispose(); h.cue.tick(0); await flush();
    expect(h.state()).toEqual({ prepares: 1, plays: 0, releases: 1 });
  });
  test("preload resolving after early unmount is released, not played", async () => {
    const loaded = deferred<CompletionSound>(); let plays = 0, releases = 0;
    const cue = createFocusCompletionCue(10, () => loaded.promise);
    cue.dispose(); loaded.resolve({ play: async () => { plays++; }, release: () => { releases++; } });
    await flush(); expect({ plays, releases }).toEqual({ plays: 0, releases: 1 });
  });
  test("navigation after zero does not truncate the two chimes", async () => {
    const h = harness(); await flush(); h.cue.tick(0); h.cue.dispose(); await flush();
    expect(h.state().plays).toBe(1); expect(h.state().releases).toBe(0);
    h.ended.resolve(); await flush(); expect(h.state().releases).toBe(1);
  });
  test("zero before preload finishes still plays once after immediate navigation", async () => {
    const loaded = deferred<CompletionSound>(); let plays = 0, releases = 0;
    const cue = createFocusCompletionCue(1, () => loaded.promise);
    cue.tick(0); cue.dispose();
    loaded.resolve({ play: async () => { plays++; }, release: () => { releases++; } });
    await flush(); expect({ plays, releases }).toEqual({ plays: 1, releases: 1 });
  });
  test("a stalled download cannot cause a late surprise alert", async () => {
    const loaded = deferred<CompletionSound>(); let now = 0, plays = 0, releases = 0;
    const cue = createFocusCompletionCue(1, () => loaded.promise, () => now);
    cue.tick(0); now = 4000;
    loaded.resolve({ play: async () => { plays++; }, release: () => { releases++; } });
    await flush(); expect({ plays, releases }).toEqual({ plays: 0, releases: 1 });
  });
  test("load and playback failures are non-blocking and release resources", async () => {
    const failed = createFocusCompletionCue(1, async () => { throw new Error("load failed"); });
    expect(() => failed.tick(0)).not.toThrow(); await flush(); failed.dispose();
    let releases = 0;
    const blocked = createFocusCompletionCue(1, async () => ({
      play: async () => { throw new Error("autoplay blocked"); }, release: () => { releases++; },
    }));
    blocked.tick(0); await flush(); expect(releases).toBe(1);
  });
});

describe("approved audio asset transport", () => {
  test("only managed preview HTTP is upgraded", () => {
    expect(focusSoundDownloadUri("http://test.runable.site/assets/chime.mp3?a=1")).toBe("https://test.runable.site/assets/chime.mp3?a=1");
    for (const uri of ["http://localhost:4300/chime.mp3", "http://192.168.1.2:8081/chime.mp3", "https://other.example/chime.mp3", "http://runable.site.other.example/chime.mp3"])
      expect(focusSoundDownloadUri(uri)).toBe(uri);
  });
  test("redirect HTML and mismatched/missing cache are rejected", () => {
    expect(validFocusSound({ exists: true, ...focusSoundFingerprint })).toBe(true);
    expect(validFocusSound({ exists: true, size: 167, md5: "0104c301c5e02bd6148b8703d19b3a73" })).toBe(false);
    expect(validFocusSound({ exists: false, ...focusSoundFingerprint })).toBe(false);
    expect(validFocusSound({ exists: true, size: focusSoundFingerprint.size, md5: null })).toBe(false);
  });
  test("bundled file is exactly the approved normalized preview", async () => {
    const bytes = await Bun.file(new URL("../assets/sounds/focus-complete.mp3", import.meta.url)).arrayBuffer();
    expect(bytes.byteLength).toBe(focusSoundFingerprint.size);
    expect(new Bun.CryptoHasher("md5").update(bytes).digest("hex")).toBe(focusSoundFingerprint.md5);
  });
});
