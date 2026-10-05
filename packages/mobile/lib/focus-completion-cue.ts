export type CompletionSound = {
  /** Resolves after playback ends (or a bounded failure timeout). */
  play: () => Promise<void>;
  release: () => void;
};

/** One lifetime per mounted countdown. Audio never controls task completion. */
export function createFocusCompletionCue(
  initial: number,
  prepare: () => Promise<CompletionSound>,
  now = Date.now,
) {
  let previous = initial;
  let fired = false;
  let disposed = false;
  let sound: CompletionSound | null = null;
  const ready = initial > 0
    ? Promise.resolve().then(prepare).then(value => {
        sound = value;
        if (disposed && !fired) { value.release(); sound = null; }
        return sound;
      }).catch(() => null)
    : Promise.resolve(null);

  return {
    tick(next: number) {
      if (disposed || fired) return;
      const crossedZero = previous > 0 && next === 0;
      previous = next;
      if (!crossedZero) return;
      fired = true;
      const finishedAt = now();
      void ready.then(async value => {
        if (!value) return;
        try {
          // Do not surprise the user with a late alert after a stalled download.
          if (now() - finishedAt <= 3000) await value.play();
        } catch {
          // A muted/blocked/unavailable output must not interrupt the note flow.
        } finally {
          value.release();
          sound = null;
        }
      });
    },
    dispose() {
      disposed = true;
      // A natural completion owns its short playback across route replacement.
      if (!fired) { sound?.release(); sound = null; }
    },
  };
}
