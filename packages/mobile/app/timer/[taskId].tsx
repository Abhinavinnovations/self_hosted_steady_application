import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  ImageBackground,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SteadyIcon } from "@/components/steady-icon";
import * as Haptics from "expo-haptics";
import { useFocusAwake } from "@/hooks/use-focus-awake";
import { focusKey, remainingAt } from "@/lib/focus-progress";
import { readFocus, saveFocus } from "@/lib/focus-storage";
import { createFocusCompletionCue } from "@/lib/focus-completion-cue";
import { prepareFocusCompletionSound } from "@/lib/focus-completion-sound";
import { Colors, Fonts } from "@/constants/theme";
import { useToday } from "@/queries/steady";
import { useTodos, useToggleTodo } from "@/queries/todos";
import { cancelReminder, todoReminderId } from "@/lib/reminders";

/**
 * Full-screen focus timer: a task-matched backdrop, a big countdown from the
 * task's assigned duration, pause / resume / stop.
 *
 * Works for both kinds of work:
 * - Consistent tasks (`/timer/<id>`): natural finish goes back to Today with
 *   the note sheet open — the streak still demands its one line.
 * - To-dos (`/timer/<id>?type=todo`): natural finish just checks the to-do
 *   off. Casual list, no note required.
 *
 * Progress persists per item per local day: stop a 60-min task at 40:00 left
 * and reopening it later the same day resumes from 40:00. A new day resets
 * consistent tasks; each to-do occurrence keeps its own balance, including zero.
 */

const IMAGES: Record<string, ReturnType<typeof require>> = {
  gym: require("../../assets/timer/gym.jpg"),
  run: require("../../assets/timer/run.jpg"),
  read: require("../../assets/timer/read.jpg"),
  meditate: require("../../assets/timer/meditate.jpg"),
  work: require("../../assets/timer/work.jpg"),
  default: require("../../assets/timer/default.jpg"),
};

const KEYWORDS: [RegExp, keyof typeof IMAGES][] = [
  [/gym|lift|weight|push.?up|pull.?up|squat|workout|train|exercise/i, "gym"],
  [/run|jog|walk|steps|sprint|cardio|cycle|bike/i, "run"],
  [/read|book|page|chapter|study|learn/i, "read"],
  [/medit|breath|yoga|journal|gratitude|pray|stretch|mindful/i, "meditate"],
  [/code|work|write|writ|build|practice|project|draw|design/i, "work"],
];

function imageForTitle(title: string) {
  for (const [re, key] of KEYWORDS) {
    if (re.test(title)) return IMAGES[key];
  }
  return IMAGES.default;
}

function fmt(totalSeconds: number) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function TimerScreen() {
  useFocusAwake();
  // Route-local palette. Never changes the saved Light/Dark/Auto preference.
  const colors = Colors.dark;
  const { width, fontScale } = useWindowDimensions();
  const router = useRouter();
  const { taskId, type, occurrenceDate } = useLocalSearchParams<{
    taskId: string;
    type?: string;
    occurrenceDate?: string;
  }>();
  const isTodo = type === "todo";
  const today = useToday();
  const todos = useTodos();
  const toggleTodo = useToggleTodo();

  const liveItem = useMemo(() => {
    if (isTodo) {
      const t = todos.data?.todos.find((x) => String(x.id) === String(taskId));
      if (!t || t.completedAt || (occurrenceDate && t.occurrenceDate !== occurrenceDate)) return undefined;
      return { id: t.id, title: t.title, durationMinutes: t.durationMinutes, day: t.occurrenceDate };
    }
    const t = today.data?.tasks.find((x) => String(x.id) === String(taskId));
    if (!t) return undefined;
    return { id: t.id, title: t.title, durationMinutes: t.durationMinutes, day: today.data!.localDate };
  }, [isTodo, todos.data, today.data, taskId, occurrenceDate]);
  // Freeze identity/date once armed, even if a refetch crosses midnight.
  const captured = useRef<typeof liveItem>(undefined);
  if (!captured.current && liveItem) captured.current = liveItem;
  const item = captured.current;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const sourceReady = isTodo ? todos.isSuccess : today.isSuccess;
  const localDay = item?.day ?? null;
  const storeKey =
    item && localDay ? focusKey({ kind: isTodo ? "todo" : "task", id: item.id, day: localDay }) : null;

  const totalSeconds = (item?.durationMinutes ?? 0) * 60;
  const [remaining, setRemaining] = useState<number | null>(null);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const endRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const latestRef = useRef<number | null>(null);
  const lastSaveRef = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  /** Checkpoint the remaining seconds, including zero. */
  const persist = useCallback(
    (left: number | null) => {
      if (!storeKey || left === null) return;
      void saveFocus(storeKey, left).catch(() => setSaveError("Focus progress could not be stored on this device. Keep this screen open and check device storage."));
    },
    [storeKey],
  );

  // Arm the countdown once the item is known — resuming today's saved
  // progress when there is any.
  useEffect(() => {
    if (!item || !storeKey || remaining !== null || totalSeconds <= 0) return;
    let cancelled = false;
    void (async () => {
      let start = totalSeconds;
      try {
        start = await readFocus(storeKey, totalSeconds);
      } catch {
        // Never silently reset elapsed work if local storage cannot be read.
        if (!cancelled) setSaveError("Could not read saved focus progress. Close and reopen after checking device storage.");
        return;
      }
      if (cancelled) return;
      latestRef.current = start;
      setRemaining(start);
      endRef.current = Date.now() + start * 1000;
      if (start < totalSeconds) setResumedFrom(start);
    })();
    return () => {
      cancelled = true;
    };
  }, [item, storeKey, remaining, totalSeconds]);

  const cueRef = useRef<ReturnType<typeof createFocusCompletionCue> | null>(null);
  const stoppingRef = useRef(false);
  const armed = remaining !== null;
  useEffect(() => {
    if (!armed) return;
    const cue = createFocusCompletionCue(latestRef.current ?? 0, prepareFocusCompletionSound);
    cueRef.current = cue;
    return () => { cue.dispose(); cueRef.current = null; };
  }, [armed]);

  // Tick. Only a running countdown can emit the completion sound.
  useEffect(() => {
    if (!armed || paused) return;
    const id = setInterval(() => {
      if (endRef.current === null || stoppingRef.current || finishedRef.current) return;
      const left = Math.round((endRef.current - Date.now()) / 1000);
      const next = left > 0 ? left : 0;
      cueRef.current?.tick(next);
      latestRef.current = next;
      setRemaining(next);
      // Checkpoint every few seconds so a killed app still resumes closely.
      const now = Date.now();
      if (next > 0 && now - lastSaveRef.current > 5000) {
        lastSaveRef.current = now;
        persist(next);
      }
    }, 250);
    return () => clearInterval(id);
  }, [armed, paused, persist]);

  // Persist whatever is left when the screen unmounts (back gesture, etc.).
  useEffect(() => {
    return () => {
      if (!finishedRef.current) persist(remainingAt(endRef.current, latestRef.current, pausedRef.current, Date.now()));
    };
  }, [persist]);

  // Background/app-switch saves a fresh balance, not the previous display tick.
  useEffect(() => {
    const checkpoint = () => { if (!finishedRef.current) persist(remainingAt(endRef.current, latestRef.current, pausedRef.current, Date.now())); };
    const sub = AppState.addEventListener("change", state => { if (state !== "active") checkpoint(); });
    if (Platform.OS === "web") window.addEventListener("pagehide", checkpoint);
    return () => { sub.remove(); if (Platform.OS === "web") window.removeEventListener("pagehide", checkpoint); };
  }, [persist]);

  // Natural finish → retain zero remaining, then:
  // consistent task = back to Today with the note sheet;
  // to-do = check it off and go back. No note, no ceremony.
  useEffect(() => {
    if (remaining === 0 && !finishedRef.current) {
      finishedRef.current = true;
      void (async () => {
        try {
          // Do not leave with an unstored zero: reopening must not restart the target.
          if (storeKey) await saveFocus(storeKey, 0);
          if (!mounted.current) return;
          if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          if (isTodo && item) {
            await toggleTodo.mutateAsync({ id: item.id, done: true, occurrenceDate: item.day });
            await cancelReminder(`${todoReminderId(item.id)}:${item.day}`);
            if (mounted.current) router.replace("/(tabs)");
          } else if (item && today.data?.localDate !== item.day) {
            setSaveError("The date changed during focus. Return to Today to review your current commitment.");
          } else {
            router.replace({ pathname: "/(tabs)", params: { note: String(taskId), noteDate: item?.day } });
          }
        } catch (error) {
          if (mounted.current) setSaveError(error instanceof Error ? error.message : "Could not store focus completion. Check device storage and connectivity, then retry.");
        }
      })();
    }
  }, [remaining, router, taskId, storeKey, isTodo, item, toggleTodo, today.data?.localDate, attempt]);

  function togglePause() {
    if (remaining === null) return;
    if (paused) {
      endRef.current = Date.now() + remaining * 1000;
      pausedRef.current = false;
      setPaused(false);
    } else {
      const left = remainingAt(endRef.current, latestRef.current, false, Date.now());
      pausedRef.current = true;
      latestRef.current = left;
      setRemaining(left);
      setPaused(true);
      persist(left);
    }
  }

  async function stop() {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    const left = remainingAt(endRef.current, latestRef.current, pausedRef.current, Date.now());
    try {
      if (storeKey && left !== null) await saveFocus(storeKey, left);
      if (mounted.current) { if (router.canGoBack()) router.back(); else router.replace("/(tabs)"); }
    } catch {
      stoppingRef.current = false;
      if (mounted.current) setSaveError("Focus progress could not be stored. Check device storage, then try Stop again.");
    }
  }

  // Item missing (already completed elsewhere / bad id / no duration) — bail out.
  useEffect(() => {
    if (finishedRef.current) return;
    if (sourceReady && (!item || !item.durationMinutes)) {
      router.replace("/(tabs)");
    }
  }, [sourceReady, item, router]);

  if (!item || totalSeconds === 0) {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  const elapsedRatio =
    remaining === null ? 0 : 1 - remaining / Math.max(1, totalSeconds);

  return (
    <ImageBackground
      source={imageForTitle(item.title)}
      resizeMode="cover"
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      {/* Scrim for legibility */}
      <View
        style={{
          ...({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const),
          backgroundColor: "rgba(10,10,16,0.45)",
        }}
      />
      <SafeAreaView edges={["top", "left", "right", "bottom"]} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 24, width: "100%", maxWidth: 700, alignSelf: "center" }}>
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ flex: 1 }}>
            <Text
              style={{
                color: "rgba(255,255,255,0.72)",
                fontFamily: Fonts?.medium,
                fontSize: 13,
                letterSpacing: 1.4,
                textTransform: "uppercase",
              }}
            >
              {isTodo ? "To-do" : "Focus"}
            </Text>
            <Text
              style={{
                marginTop: 4,
                color: "#FFFFFF",
                fontFamily: Fonts.display,
                fontWeight: "normal", fontStyle: "normal", includeFontPadding: false,
                fontSize: 38,
                lineHeight: 44,
              }}
            >
              {item.title}
            </Text>
          </View>
        </View>

        {/* Countdown */}
        <View style={{ flex: 1, minHeight: 240, alignItems: "center", justifyContent: "center" }}>
          <Text
            style={{
              color: "#FFFFFF",
              fontFamily: Fonts?.mono,
              fontSize: Math.min(72, (Math.min(width, 700) - 52) / (fmt(remaining ?? totalSeconds).length * 0.64 * Math.max(1, fontScale))),
              fontVariant: ["tabular-nums"],
              letterSpacing: 0,
            }}
          >
            {fmt(remaining ?? totalSeconds)}
          </Text>
          <Text
            style={{
              marginTop: 8,
              color: "rgba(255,255,255,0.65)",
              fontFamily: Fonts?.sans,
              fontSize: 14,
            }}
          >
            {paused ? "Paused" : `of ${fmt(totalSeconds)}`}
          </Text>
          {/* Thin progress line */}
          <View
            style={{
              marginTop: 22,
              width: 220,
              height: 3,
              borderRadius: 2,
              backgroundColor: "rgba(255,255,255,0.22)",
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${Math.min(100, elapsedRatio * 100)}%`,
                height: "100%",
                backgroundColor: "#FFFFFF",
              }}
            />
          </View>
          {resumedFrom !== null && (
            <Text
              style={{
                marginTop: 14,
                color: "rgba(255,255,255,0.55)",
                fontFamily: Fonts?.sans,
                fontSize: 13,
              }}
            >
              Resumed · {fmt(totalSeconds - resumedFrom)} already done today
            </Text>
          )}
        </View>

        {saveError && <View style={{padding:16,backgroundColor:colors.card,borderWidth:1,borderColor:colors.inputBorder,borderRadius:14,gap:12}}><Text accessibilityLiveRegion="polite" style={{color:colors.foreground,fontFamily:Fonts.sans}}>{saveError}</Text>{remaining === 0 && <Pressable accessibilityRole="button" onPress={()=>{setSaveError(null);finishedRef.current=false;setAttempt(x=>x+1);}} style={{minHeight:44,justifyContent:"center"}}><Text style={{color:colors.primary,fontFamily:Fonts.semibold}}>Retry saving completion</Text></Pressable>}<Pressable accessibilityRole="button" onPress={()=>router.replace("/(tabs)")} style={{minHeight:44,justifyContent:"center"}}><Text style={{color:colors.foreground,fontFamily:Fonts.medium}}>Return to Today</Text></Pressable></View>}
        {/* Controls */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 28,
            paddingBottom: 18,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop focus timer"
            onPress={stop}
            style={({ pressed }) => ({
              width: 60,
              height: 60,
              borderRadius: 30,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(255,255,255,0.14)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.25)",
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <SteadyIcon name="stop" size={24} color="#FFFFFF" />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={paused ? "Resume timer" : "Pause timer"}
            disabled={remaining === 0}
            onPress={togglePause}
            style={({ pressed }) => ({
              width: 84,
              height: 84,
              borderRadius: 42,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.primary,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <SteadyIcon
              name={paused ? "play" : "pause"}
              size={34}
              color={colors.primaryForeground}
              style={paused ? { marginLeft: 4 } : undefined}
            />
          </Pressable>
          {/* Spacer to keep the pause button centered */}
          <View style={{ width: 60, height: 60 }} />
        </View>
      </ScrollView>
      </SafeAreaView>
    </ImageBackground>
  );
}
