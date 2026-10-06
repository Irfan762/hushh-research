"use client";

/**
 * Secure on-device card reveal, shared by /one/wallet and the Agent One chat
 * widget. The browser decrypts the card under the vault key and renders it
 * here; the values never enter chat messages, model context, telemetry or
 * browser storage. They are held in component state only, and they leave the
 * screen after a short window, on Hide, or as soon as the page is hidden
 * (the app sent to the background, the tab switched away).
 */

import { useCallback, useEffect, useState } from "react";

import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { Check, Copy } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cardNetworkLabel } from "@/components/wallet/card-network-mark";
import { WalletCardFace } from "@/components/wallet/wallet-card-face";
import type {
  WalletCardSecrets,
  WalletCardSummary,
} from "@/lib/services/wallet-service";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";
import { formatCardExpiry, formatCardNumber } from "@/lib/wallet/wallet-card-presentation";

const AUTO_HIDE_SECONDS = 45;
const COPIED_MS = 2000;

export interface SecureCardRevealProps {
  summary: WalletCardSummary;
  secrets: WalletCardSecrets;
  onDismiss?: () => void;
  /** When set, hiding (tap or auto-hide) hands control back immediately, with no interstitial. */
  onHide?: () => void;
  /**
   * Draw the revealed card face above the details. The Wallet page passes
   * false because the focused card in its stack already shows the face.
   */
  showFace?: boolean;
}

type SecretRow = {
  id: string;
  /** What the confirmation names, e.g. "Card number copied." */
  noun: string;
  copyLabel: string;
  label: string;
  value: string;
  copyValue: string;
  testId?: string;
};

function rowsFor(summary: WalletCardSummary, secrets: WalletCardSecrets): SecretRow[] {
  const rows: SecretRow[] = [
    {
      id: "number",
      noun: "Card number",
      copyLabel: "Copy card number",
      label: "Card number",
      value: formatCardNumber(summary.brand, secrets.pan),
      copyValue: secrets.pan,
      testId: "secure-card-reveal-pan",
    },
    {
      id: "expiry",
      noun: "Expiry date",
      copyLabel: "Copy expiry date",
      label: "Expires",
      value: formatCardExpiry(summary.expiryMonth, summary.expiryYear),
      copyValue: `${String(summary.expiryMonth).padStart(2, "0")}/${summary.expiryYear}`,
    },
  ];
  if (secrets.cvv) {
    rows.push({ id: "cvv", noun: "CVV", copyLabel: "Copy CVV", label: "CVV", value: secrets.cvv, copyValue: secrets.cvv });
  }
  if (secrets.pin) {
    rows.push({ id: "pin", noun: "PIN", copyLabel: "Copy PIN", label: "PIN", value: secrets.pin, copyValue: secrets.pin });
  }
  if (secrets.cardholderName) {
    rows.push({
      id: "name",
      noun: "Name on card",
      copyLabel: "Copy name on card",
      label: "Name on card",
      value: secrets.cardholderName,
      copyValue: secrets.cardholderName,
    });
  }
  return rows;
}

export function SecureCardReveal({
  summary,
  secrets,
  onDismiss,
  onHide,
  showFace = true,
}: SecureCardRevealProps) {
  const [secondsLeft, setSecondsLeft] = useState(AUTO_HIDE_SECONDS);
  const [hidden, setHidden] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const hide = useCallback(() => {
    if (onHide) {
      onHide();
      return;
    }
    setHidden(true);
  }, [onHide]);

  useEffect(() => {
    if (hidden) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hidden]);

  useEffect(() => {
    if (!hidden && secondsLeft === 0) hide();
  }, [hidden, hide, secondsLeft]);

  // Leaving the app hides the card, so it is not on screen when the person
  // returns or in the app switcher's snapshot.
  useEffect(() => {
    if (hidden) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [hidden, hide]);

  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(null), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const copy = async (row: SecretRow) => {
    try {
      await navigator.clipboard.writeText(row.copyValue);
      setCopiedId(row.id);
      setAnnouncement(`${row.noun} copied.`);
    } catch {
      setCopiedId(null);
      setAnnouncement("Copying is not available here.");
    }
  };

  if (hidden) {
    return (
      <div
        className="flex min-h-14 w-full max-w-[26.5rem] items-center justify-between gap-3 rounded-[var(--app-radius-lg)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] pl-4 pr-2"
        data-testid="secure-card-reveal-hidden"
      >
        <span className={TYPOGRAPHY_CLASSNAMES.helperText}>Hidden again.</span>
        {onDismiss ? (
          <Button variant="secondary" size="compact" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
    );
  }

  const title = summary.nickname || cardNetworkLabel(summary.brand);
  const rows = rowsFor(summary, secrets);

  return (
    <section
      aria-label={`${title} details`}
      className="flex w-full max-w-[26.5rem] flex-col gap-3"
      data-testid="secure-card-reveal"
    >
      {showFace ? (
        <WalletCardFace
          summary={summary}
          revealed={{ pan: secrets.pan, cardholderName: secrets.cardholderName }}
        />
      ) : null}

      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground font-medium">
        <span className="flex items-center gap-1.5 text-emerald-500 dark:text-emerald-400 font-semibold">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Decrypted in Vault
        </span>
        <span className="text-[11px] text-muted-foreground/80">AES-256 Memory-Only</span>
      </div>

      <ul
        data-slot="secure-card-rows"
        className="m-0 list-none overflow-hidden rounded-2xl border border-border/60 bg-card/90 shadow-2xs p-0 divide-y divide-border/40"
      >
        {rows.map((row) => {
          const copied = copiedId === row.id;
          return (
            <li key={row.id} className="relative">
              <button
                type="button"
                onClick={() => void copy(row)}
                aria-label={row.copyLabel}
                data-testid={row.testId}
                data-copied={copied ? "true" : "false"}
                className="relative flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-2.5 text-left outline-none hover:bg-muted/30 focus-visible:bg-muted/50 transition-colors"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{row.label}</span>
                  <span className={cn(TYPOGRAPHY_CLASSNAMES.rowLabel, "truncate tabular-nums font-mono text-sm tracking-wide text-foreground")}>
                    {row.value}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors",
                    copied ? "bg-emerald-500/10 text-emerald-500" : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {copied ? (
                    <>
                      <Check className="size-3.5" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="size-4" />
                      <span className="sr-only">Copy</span>
                    </>
                  )}
                </span>
                <MaterialRipple variant="none" effect="fade" />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex min-h-10 items-center justify-between gap-3 px-1 pt-0.5">
        <span className="text-xs font-medium text-muted-foreground" data-testid="secure-card-countdown">
          Auto-hides in <span className="font-mono text-foreground font-semibold">{secondsLeft}s</span>
        </span>
        <Button variant="secondary" size="compact" className="h-9 rounded-xl px-4 text-xs font-semibold" onClick={hide} data-testid="secure-card-hide">
          Hide details
        </Button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  );
}
