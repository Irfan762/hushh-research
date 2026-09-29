"use client";

import { Check, ShieldOff } from "@/components/icons";

/**
 * Right-aligned user-side chip summarizing a card selection, styled to match the
 * central chat's primary user bubble so both surfaces read consistently.
 *
 * `ended` is a sharing that has since stopped ("Kushal stopped sharing Food
 * preferences"): it carries the same neutral ended mark as the "Access ended"
 * notice, never a check, which read as a success.
 */
export function SelectionChip({ label, ended = false }: { label: string; ended?: boolean }) {
  const Icon = ended ? ShieldOff : Check;
  return (
    <div className="flex w-full justify-end" data-testid="selection-chip" data-state={ended ? "ended" : "done"}>
      <span className="inline-flex items-center gap-1.5 rounded-2xl bg-primary/10 px-3.5 py-1.5 text-sm font-medium text-primary shadow-sm shadow-primary/5">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {label}
      </span>
    </div>
  );
}
