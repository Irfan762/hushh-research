"use client";

import type { ComponentPropsWithRef } from "react";
import { BOTTOM_CHROME_COLUMN_CLASSNAME } from "@/components/app-ui/bottom-chrome-column";
import { cn } from "@/lib/utils";

/** One presentation for voice capture and Chat input; no routing or microphone authority. */
export function AgentBarSurface({ className, ...props }: ComponentPropsWithRef<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "bottom-chrome-surface pointer-events-auto relative flex min-h-11 items-center overflow-hidden rounded-full",
        BOTTOM_CHROME_COLUMN_CLASSNAME,
        className,
      )}
    />
  );
}
