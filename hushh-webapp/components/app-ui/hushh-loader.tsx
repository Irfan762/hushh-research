"use client";

import React from "react";
import { cva } from "class-variance-authority";

import { BootScene } from "@/components/app-ui/boot-surface";
import type { BootStage } from "@/lib/boot/boot-sequence";
import { useBootStageClaim } from "@/lib/boot/boot-surface-store";
import { cn } from "@/lib/utils";

export type HushhLoaderVariant = "fullscreen" | "page" | "inline" | "compact";

export interface HushhLoaderProps {
  label?: string;
  variant?: HushhLoaderVariant;
  className?: string;
  /**
   * A boot or guard stage (session, vault, phone, setup, workspace, ...).
   * With a stage, this loader paints nothing of its own: it holds the one
   * persistent boot surface on that stage (`components/app-ui/boot-surface.tsx`),
   * so a chain of guards reads as one continuous screen instead of a new
   * loader per guard. `label` is then the precise internal detail, kept as
   * `data-boot-detail` for diagnostics; the person sees the stage's line.
   */
  stage?: BootStage;
  /**
   * `contained` renders the boot scene in place instead of holding the
   * surface. Only for hosts the surface cannot paint above: the session
   * privacy gate is a top-layer modal dialog.
   */
  presentation?: "surface" | "contained";
}

/**
 * HushhLoader
 * Single canonical loader for the entire app (branding symmetry).
 *
 * IMPORTANT:
 * - No debug strings (per product decision).
 * - UI-only. No backend/plugin involvement.
 * - No spinner/progress glyphs here; top StepProgressBar owns progress indication.
 * - Without a `stage`, this component renders only neutral static placeholder text.
 */
const loaderVariants = cva("flex items-center justify-center text-muted-foreground", {
  variants: {
    variant: {
      fullscreen: "h-screen w-full",
      page: "min-h-[60vh] w-full",
      inline: "w-full py-6",
      compact: "inline-block",
    },
  },
  defaultVariants: {
    variant: "page",
  },
});

function BootStageHold({ stage, detail }: { stage: BootStage; detail?: string }) {
  useBootStageClaim(stage);
  return <span hidden data-boot-stage={stage} data-boot-detail={detail} />;
}

export function HushhLoader({
  label = "Loading…",
  variant = "page",
  className,
  stage,
  presentation = "surface",
}: HushhLoaderProps) {
  if (stage) {
    if (presentation === "contained") {
      return <BootScene stage={stage} contained />;
    }
    return <BootStageHold stage={stage} detail={label} />;
  }

  if (variant === "compact") {
    return (
      <span className={cn(loaderVariants({ variant }), className)} aria-hidden="true">
        …
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-atomic="true"
      className={cn(loaderVariants({ variant }), className)}
    >
      <p className={cn("text-sm motion-safe:animate-pulse", variant === "inline" && "text-xs")}>{label}</p>
    </div>
  );
}
