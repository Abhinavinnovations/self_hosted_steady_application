import { Asset } from "expo-asset";
import { createAudioPlayer, setAudioModeAsync, type AudioSource } from "expo-audio";
import { File, Paths } from "expo-file-system";
import type { CompletionSound } from "./focus-completion-cue";
import { focusSoundDownloadUri, focusSoundFingerprint, validFocusSound } from "./focus-sound-asset";

const source = require("../assets/sounds/focus-complete.mp3");

async function verifiedSource(): Promise<AudioSource> {
  const asset = Asset.fromModule(source);
  if (!/^https?:\/\//i.test(asset.uri)) return source;
  // Older Android Expo asset downloads cached a redirect HTML page as media.
  const file = new File(Paths.cache, `SteadySound-${focusSoundFingerprint.md5}.mp3`);
  if (!validFocusSound(file)) {
    await File.downloadFileAsync(focusSoundDownloadUri(asset.uri), file, { idempotent: true });
  }
  if (!validFocusSound(file)) throw new Error("Invalid focus sound asset");
  return { uri: file.uri };
}

export async function prepareFocusCompletionSound(): Promise<CompletionSound> {
  const player = createAudioPlayer(await verifiedSource(), { updateInterval: 100 });
  player.loop = false;
  player.volume = 1;
  let released = false;
  const release = () => { if (!released) { released = true; player.remove(); } };
  try {
    if (!player.isLoaded) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { sub.remove(); reject(new Error("Focus sound load timeout")); }, 8000);
      const sub = player.addListener("playbackStatusUpdate", status => {
        if (status.isLoaded) { clearTimeout(timeout); sub.remove(); resolve(); }
      });
    });
  } catch (error) { release(); throw error; }

  return {
    release,
    async play() {
      if (released) return;
      await setAudioModeAsync({ playsInSilentMode: true, interruptionMode: "mixWithOthers" });
      if (released) return;
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timeout); sub.remove(); resolve(); };
        const timeout = setTimeout(finish, 5000);
        const sub = player.addListener("playbackStatusUpdate", status => { if (status.didJustFinish) finish(); });
        try { player.play(); } catch (error) { clearTimeout(timeout); sub.remove(); reject(error); }
      });
    },
  };
}
