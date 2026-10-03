"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";

import {
  activeBootStage,
  BOOT_TIMING,
  IDLE_BOOT_STATE,
  isBootSurfaceShown,
  LAUNCH_BOOT_STATE,
  launchBootState,
  nextBootDeadline,
  reduceBoot,
  type BootLaunch,
  type BootStage,
  type BootState,
} from "@/lib/boot/boot-sequence";

/**
 * Claim registry and timer driver for the one boot surface.
 *
 * Guards do not paint loaders any more. While a guard is waiting it holds a
 * claim on a stage (`useBootStageClaim`), and the single surface mounted in
 * the root layout shows the earliest held stage. Because the surface lives
 * above every guard, it stays mounted while one guard hands over to the next,
 * and while a guard redirects into another route whose own guard picks the
 * claim up.
 *
 * Releases are evaluated in a microtask after the commit. React runs a
 * departing guard's cleanup and an arriving guard's layout effect in the same
 * commit, so evaluating inside the commit would see a transient "nothing
 * held" and start an exit between two stages of one boot; a microtask sees the
 * settled set before the frame paints. (A timer was measured first: on a
 * loaded device it fired 171 ms after the resolved screen mounted, because it
 * queued behind that screen's own work.)
 *
 * Each change of the active stage is written to the performance timeline as
 * `hushh:boot:<stage>` marks and measures, and the first moment nothing is
 * held as `hushh:boot:ready`. The surface itself marks
 * `hushh:boot:surface-shown`, `hushh:boot:surface-released` (the exit begins
 * and input passes through to the app) and `hushh:boot:surface-idle` (fully
 * clear), so a cold start can be read on any device without a debugger.
 */

type Listener = () => void;

const claims = new Map<number, BootStage>();
const listeners = new Set<Listener>();
let claimSequence = 0;
let state: BootState = LAUNCH_BOOT_STATE;
let started = false;
let routeCommitted = false;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
let settleQueued = false;
let markedStage: BootStage | null = null;
let markedStageAt = 0;
let readyMarked = false;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function emit(): void {
  for (const listener of listeners) listener();
}

function mark(name: string): void {
  try {
    performance.mark(name);
  } catch {
    // The performance timeline is diagnostic only.
  }
}

function recordStage(stage: BootStage | null, at: number): void {
  if (stage === markedStage) return;
  if (markedStage) {
    try {
      performance.measure(`hushh:boot:${markedStage}`, {
        start: markedStageAt,
        end: at,
      });
    } catch {
      // Diagnostic only.
    }
  }
  markedStage = stage;
  markedStageAt = at;
  if (stage) {
    mark(`hushh:boot:${stage}`);
  } else if (routeCommitted && !readyMarked) {
    readyMarked = true;
    mark("hushh:boot:ready");
  }
}

function commit(next: BootState): void {
  if (next === state) return;
  const previousPhase = state.phase;
  const wasShown = isBootSurfaceShown(state.phase);
  const isShown = isBootSurfaceShown(next.phase);
  state = next;
  if (!wasShown && isShown) mark("hushh:boot:surface-shown");
  if (wasShown && !isShown) mark("hushh:boot:surface-released");
  if (next.phase === "idle" && previousPhase === "exiting") mark("hushh:boot:surface-idle");
  armDeadline();
  emit();
}

function armDeadline(): void {
  if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  deadlineTimer = null;
  const deadline = nextBootDeadline(state);
  if (deadline === null) return;
  const delay = Math.max(0, deadline - now());
  deadlineTimer = setTimeout(() => {
    deadlineTimer = null;
    commit(reduceBoot(state, { type: "tick", at: now() }));
    // A tick that changed nothing (a timer that fired early) re-arms itself.
    if (deadlineTimer === null) armDeadline();
  }, delay);
}

function evaluate(): void {
  // Before the first route has committed, "nothing held" only means the
  // guards have not mounted yet; keep the launch surface up.
  const stage = activeBootStage(claims.values());
  if (stage === null && !routeCommitted) return;
  const at = now();
  recordStage(stage, at);
  commit(reduceBoot(state, { type: "stage", stage, at }));
}

function scheduleEvaluate(immediate: boolean): void {
  if (!started) return;
  if (immediate) {
    evaluate();
    return;
  }
  if (settleQueued) return;
  settleQueued = true;
  queueMicrotask(() => {
    settleQueued = false;
    evaluate();
  });
}

function detectLaunch(): BootLaunch {
  if (typeof document === "undefined") return "web";
  const root = document.documentElement;
  return root.classList.contains("native-ios") ||
    root.classList.contains("native-android")
    ? "native"
    : "web";
}

/**
 * Called once by the mounted surface. The client takes over the cold
 * document's surface from the time already elapsed since navigation start.
 */
export function startBootSurface(launch: BootLaunch = detectLaunch()): void {
  if (started) return;
  started = true;
  // Only the cold document's surface is taken over; a store that already
  // left it (a test seam, a remount) keeps its state.
  if (state === LAUNCH_BOOT_STATE) state = launchBootState(launch, now());
  armDeadline();
  emit();
  scheduleEvaluate(false);
}

/** The route tree has committed at least once, so an empty claim set is real. */
export function markBootRouteCommitted(): void {
  if (routeCommitted) return;
  routeCommitted = true;
  scheduleEvaluate(false);
}

/** Hold the surface on a stage until the returned release is called. */
export function claimBootStage(stage: BootStage): () => void {
  const id = ++claimSequence;
  claims.set(id, stage);
  scheduleEvaluate(true);
  return () => {
    if (!claims.delete(id)) return;
    scheduleEvaluate(false);
  };
}

export function subscribeBootSurface(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBootSurfaceState(): BootState {
  return state;
}

function getServerBootSurfaceState(): BootState {
  return LAUNCH_BOOT_STATE;
}

export function useBootSurfaceState(): BootState {
  return useSyncExternalStore(
    subscribeBootSurface,
    getBootSurfaceState,
    getServerBootSurfaceState,
  );
}

/**
 * Hold the boot surface on `stage` while mounted; `null` holds nothing.
 * Registered in a layout effect so the claim exists before the frame that
 * would otherwise paint the bare route underneath.
 */
export function useBootStageClaim(stage: BootStage | null): void {
  useLayoutEffect(() => {
    if (!stage) return undefined;
    return claimBootStage(stage);
  }, [stage]);
}

/** Test seam: forget every claim, timer and mark, back to the cold document. */
export function resetBootSurfaceForTests(
  initial: BootState = LAUNCH_BOOT_STATE,
): void {
  claims.clear();
  listeners.clear();
  if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  deadlineTimer = null;
  settleQueued = false;
  claimSequence = 0;
  started = false;
  routeCommitted = false;
  markedStage = null;
  markedStageAt = 0;
  readyMarked = false;
  state = initial;
}

export { BOOT_TIMING, IDLE_BOOT_STATE };
