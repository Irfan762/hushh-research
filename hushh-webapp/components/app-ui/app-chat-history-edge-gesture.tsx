"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { nativeShellOverlayBlocked, useNativeNavigationBlocked } from "@/lib/capacitor/native-navigation";

const EDGE_BACK_LANE = 28;
const AXIS_LOCK = 8;
const DIRECTION_RATIO = 1.12;
const COMMIT_DISTANCE = 72;
const COMMIT_VELOCITY = 0.48;
type Gesture = {
  identifier: number; x: number; y: number; time: number;
  axis: "undecided" | "horizontal";
  width: number; panel: HTMLElement; scrim: HTMLElement;
};

function excludedTarget(target: EventTarget | null, surface: HTMLElement) {
  const element = target instanceof Element ? target : null;
  if (!element || !surface.contains(element) || element.closest(
    'button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [inert], [hidden], [data-no-route-swipe], [data-no-profile-swipe], [data-swipe-views-horizontal-scroll], [data-slot="carousel"], [data-slot="carousel-content"], [data-slot="carousel-item"], [data-slot="slider"], [role="slider"]',
  )) return true;
  // Tables, code blocks and charts retain their own horizontal pan.
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (["auto", "scroll"].includes(style.overflowX) && node.scrollWidth > node.clientWidth + 4) return true;
    if (node === surface) break;
  }
  return Boolean(window.getSelection()?.toString());
}

function domBlocked() {
  return Boolean(document.querySelector(
    'html.kb-open, [data-slot="dialog-content"][data-state="open"], [data-slot="sheet-content"][data-state="open"], [data-slot="alert-dialog-content"][data-state="open"], [data-slot="popover-content"][data-state="open"], [data-slot="command"]',
  ));
}

/** Presentation-only pull. The drawer owner supplies geometry and its authored
 * open action. No global listener, inferred button or route dispatch. React
 * changes only at gesture boundaries, never for a movement frame. */
export function AppChatHistoryEdgeGesture({ enabled, open = false, surfaceRef, drawerRef, scrimRef, onOpen }: {
  enabled: boolean;
  open?: boolean;
  surfaceRef: RefObject<HTMLElement | null>;
  drawerRef: RefObject<HTMLElement | null>;
  scrimRef: RefObject<HTMLElement | null>;
  onOpen: () => void;
}) {
  const action = useRef(onOpen);
  useLayoutEffect(() => { action.current = onOpen; }, [onOpen]);
  const [dragging, setDragging] = useState(false);
  const reconcileClose = useRef<(() => void) | null>(null);
  const wasOpen = useRef(open);
  useNativeNavigationBlocked(dragging);
  useLayoutEffect(() => {
    if (wasOpen.current && !open) reconcileClose.current?.();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const surface = surfaceRef.current;
    const panel = drawerRef.current;
    const scrim = scrimRef.current;
    if (!enabled || !surface || !panel || !scrim) return;
    let gesture: Gesture | null = null;
    let settling: Gesture | null = null;
    let settlingOpen = false;
    let timer = 0;

    const clear = (current: Gesture) => {
      for (const property of ["transition", "transform", "translate", "will-change"]) current.panel.style.removeProperty(property);
      for (const property of ["transition", "opacity", "visibility", "will-change"]) current.scrim.style.removeProperty(property);
    };
    const place = (current: Gesture, distance: number, phase: "drag" | "open" | "close") => {
      const offset = Math.min(0, Math.max(-current.width, distance - current.width));
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const motion = phase === "open" ? "enter" : "exit";
      current.panel.style.transition = phase === "drag" || reduced ? "none"
        : `transform var(--motion-sheet-${motion}-duration) var(--motion-sheet-${motion}-ease)`;
      // Tailwind v4's resting translate is independent of transform. Disable
      // it for the pull, otherwise both offsets add and the panel stays hidden.
      current.panel.style.translate = "none";
      current.scrim.style.transition = phase === "drag" || reduced ? "none"
        : `opacity var(--motion-sheet-${motion}-duration) var(--motion-sheet-${motion}-ease)`;
      current.panel.style.transform = `translate3d(${offset}px, 0, 0)`;
      current.scrim.style.opacity = String(1 - Math.abs(offset) / current.width);
      current.scrim.style.visibility = "visible";
    };
    const settle = (current: Gesture, open: boolean) => {
      gesture = null;
      settling = current;
      settlingOpen = open;
      place(current, open ? current.width : 0, open ? "open" : "close");
      if (open) action.current(); // Existing state, focus, loading and isolation owner.
      const duration = getComputedStyle(current.panel).transitionDuration.split(",").reduce((max, value) => {
        const ms = parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000);
        return Number.isFinite(ms) ? Math.max(max, ms) : max;
      }, 0);
      timer = window.setTimeout(() => {
        clear(current); settling = null; setDragging(false);
      }, duration + 30);
    };
    const cancel = () => {
      if (gesture?.axis === "horizontal") settle(gesture, false);
      else gesture = null;
    };
    reconcileClose.current = () => {
      if (settling && settlingOpen) {
        window.clearTimeout(timer);
        settle(settling, false);
      } else cancel();
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0];
      if (!touch) return;
      if (settling || panel.getAttribute("aria-hidden") !== "true" || touch.clientX <= EDGE_BACK_LANE ||
          nativeShellOverlayBlocked() || domBlocked() || excludedTarget(event.target, surface)) return;
      // Include the authored closed shadow clearance, not just panel width.
      const width = Math.max(panel.offsetWidth, -panel.getBoundingClientRect().left);
      if (width <= 0) return;
      gesture = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY,
        time: event.timeStamp, axis: "undecided", width, panel, scrim };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = Array.from(event.touches).find(point => point.identifier === gesture?.identifier);
      if (!touch || panel.getAttribute("aria-hidden") !== "true" || surface.closest("[inert], [hidden]") ||
          domBlocked()) { cancel(); return; }
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (gesture.axis === "undecided") {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK) return;
        if (dx <= 0 || Math.abs(dx) <= Math.abs(dy) * DIRECTION_RATIO || nativeShellOverlayBlocked()) { gesture = null; return; }
        gesture.axis = "horizontal";
        panel.style.willChange = "transform";
        scrim.style.willChange = "opacity";
        setDragging(true);
      }
      place(gesture, dx, "drag");
    };
    const end = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = Array.from(event.changedTouches).find(point => point.identifier === gesture?.identifier);
      if (!touch) { cancel(); return; }
      if (gesture.axis !== "horizontal") { gesture = null; return; }
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      const velocity = dx / Math.max(1, event.timeStamp - gesture.time);
      settle(gesture, !domBlocked() && panel.getAttribute("aria-hidden") === "true" && dx > 0 && dx > Math.abs(dy) * DIRECTION_RATIO &&
        (dx >= COMMIT_DISTANCE || (dx >= AXIS_LOCK * 2 && velocity >= COMMIT_VELOCITY)));
    };
    const visibility = () => { if (document.visibilityState === "hidden") cancel(); };
    const options = { passive: true } as const;
    surface.addEventListener("touchstart", start, options);
    surface.addEventListener("touchmove", move, options);
    surface.addEventListener("touchend", end, options);
    surface.addEventListener("touchcancel", cancel, options);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearTimeout(timer);
      if (gesture) clear(gesture);
      if (settling) clear(settling);
      reconcileClose.current = null;
      setDragging(false);
      surface.removeEventListener("touchstart", start);
      surface.removeEventListener("touchmove", move);
      surface.removeEventListener("touchend", end);
      surface.removeEventListener("touchcancel", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled, surfaceRef, drawerRef, scrimRef]);
  return null;
}
