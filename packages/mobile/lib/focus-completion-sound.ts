import { Asset } from "expo-asset";
import type { CompletionSound } from "./focus-completion-cue";

/** Browser implementation: handle autoplay rejection (Expo's web play is void). */
export async function prepareFocusCompletionSound(): Promise<CompletionSound> {
  const asset = Asset.fromModule(require("../assets/sounds/focus-complete.mp3"));
  const audio = new Audio(asset.uri);
  audio.preload = "auto";
  audio.loop = false;
  audio.volume = 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); audio.oncanplay = null; audio.onerror = null; };
      const timeout = setTimeout(() => { cleanup(); reject(new Error("Focus sound load timeout")); }, 8000);
      audio.oncanplay = () => { cleanup(); resolve(); };
      audio.onerror = () => { cleanup(); reject(new Error("Focus sound unavailable")); };
      audio.load();
    });
  } catch (error) { release(); throw error; }
  return {
    release,
    async play() {
      if (released) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); audio.onended = null; audio.onerror = null; };
        const timeout = setTimeout(() => { cleanup(); resolve(); }, 5000);
        audio.onended = () => { cleanup(); resolve(); };
        audio.onerror = () => { cleanup(); reject(new Error("Focus sound playback failed")); };
        void audio.play().catch(error => { cleanup(); reject(error); });
      });
    },
  };
}
