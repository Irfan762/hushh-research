/**
 * One card, drawn as the object it is: the ISO/IEC 7810 ID-1 proportion
 * (85.60 x 53.98 mm), the standard's corner radius scaled to the card, a flat
 * face tone of Hussh's own and a single photographic shadow.
 *
 * Masked, it is built from the summary alone (nickname, network, last four,
 * expiry, region) and never receives the full number. Revealed, the caller
 * passes the decrypted number and name; both live only in memory for as long
 * as the reveal is on screen.
 */

import type { ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

import { CardNetworkWordmark, cardNetworkLabel } from "@/components/wallet/card-network-mark";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import { cn } from "@/lib/utils";
import {
  CARD_CORNER_RADIUS_RATIO,
  cardFaceTone,
  formatCardExpiry,
  formatCardNumber,
  maskedCardNumberGroups,
} from "@/lib/wallet/wallet-card-presentation";

export interface WalletCardFaceProps {
  summary: WalletCardSummary;
  revealed?: { pan: string; cardholderName: string } | null;
  onToggleReveal?: () => void;
  /** Overlay slot (the press ripple), clipped to the card's corners. */
  children?: ReactNode;
  className?: string;
}

const FACE_SHADOW = "inset 0 0 0 1px rgb(255 255 255 / 0.12), var(--app-shadow-product)";

function ChipIcon({ className }: { className?: string }) {
  return (
    <svg
      width="34"
      height="24"
      viewBox="0 0 34 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <rect width="34" height="24" rx="4" fill="url(#chip-gold-grad)" />
      <rect x="0.5" y="0.5" width="33" height="23" rx="3.5" stroke="#D4AF37" strokeOpacity="0.5" />
      <path d="M0 12H11M23 12H34M11 0V24M23 0V24M11 7H23M11 17H23" stroke="#7A5C0D" strokeWidth="0.8" strokeOpacity="0.7" />
      <rect x="11" y="7" width="12" height="10" rx="1.5" fill="#F3D053" fillOpacity="0.4" stroke="#7A5C0D" strokeWidth="0.8" />
      <defs>
        <linearGradient id="chip-gold-grad" x1="0" y1="0" x2="34" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F5E096" />
          <stop offset="0.5" stopColor="#D4AF37" />
          <stop offset="1" stopColor="#AA8214" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function ContactlessIcon({ className }: { className?: string }) {
  return (
    <svg
      width="18"
      height="20"
      viewBox="0 0 18 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0 opacity-80", className)}
      aria-hidden="true"
    >
      <path d="M3.5 14C5.2 12.4 5.2 9.6 3.5 8" />
      <path d="M7 16C9.8 13.2 9.8 8.8 7 6" />
      <path d="M10.5 18C14.5 14 14.5 8 10.5 4" />
    </svg>
  );
}

function FaceField({
  caption,
  value,
  align = "start",
  slot,
}: {
  caption: string;
  value: string;
  align?: "start" | "end";
  slot: string;
}) {
  return (
    <span
      data-slot={slot}
      className={cn("flex min-w-0 flex-col", align === "end" ? "items-end text-right" : "items-start")}
    >
      <span className="text-[10px] font-bold uppercase leading-[12px] tracking-[0.08em] text-white/70">
        {caption}
      </span>
      <span className="max-w-full truncate text-[13px] font-bold uppercase leading-4 tracking-[0.04em] text-white tabular-nums">
        {value}
      </span>
    </span>
  );
}

export function WalletCardFace({ summary, revealed, onToggleReveal, children, className }: WalletCardFaceProps) {
  const tone = cardFaceTone(summary.cardId);
  const network = cardNetworkLabel(summary.brand);
  const title = summary.nickname || network;
  const groups = revealed
    ? formatCardNumber(summary.brand, revealed.pan).split(" ")
    : maskedCardNumberGroups(summary.brand, summary.last4);
  const expiry = formatCardExpiry(summary.expiryMonth, summary.expiryYear);

  return (
    <div className={cn("@container w-full", className)}>
      <div
        data-testid="wallet-card-face"
        data-card-tone={tone.id}
        data-revealed={revealed ? "true" : "false"}
        className="relative isolate flex aspect-[85.6/53.98] w-full flex-col justify-between overflow-hidden p-5 text-left text-white"
        style={{
          backgroundColor: tone.background,
          backgroundImage:
            "radial-gradient(circle at 85% 15%, rgba(99, 102, 241, 0.35), transparent 50%), radial-gradient(circle at 15% 85%, rgba(255, 255, 255, 0.05), transparent 45%)",
          borderRadius: `calc(100cqw * ${CARD_CORNER_RADIUS_RATIO})`,
          boxShadow: FACE_SHADOW,
        }}
      >
        <span data-slot="wallet-card-top" className="flex items-start justify-between gap-3">
          <span className="flex flex-col gap-1 min-w-0">
            <span className="min-w-0 truncate text-[16px] font-semibold leading-5 text-white">
              {title}
            </span>
            <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-emerald-500/20 px-2 py-0.5 text-[9px] font-bold text-emerald-400 uppercase tracking-wider">
              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
              ACTIVE
            </span>
          </span>
          <CardNetworkWordmark brand={summary.brand} />
        </span>

        <span className="flex items-center gap-3 my-0.5">
          <ChipIcon />
          <ContactlessIcon />
        </span>

        <span className="flex items-center justify-between gap-2 min-w-0">
          <span
            data-slot="wallet-card-number"
            className="flex flex-wrap gap-x-2 text-[17px] font-semibold leading-[22px] tracking-[0.06em] text-white tabular-nums"
          >
            <span className="sr-only">
              {revealed
                ? `Card number ${formatCardNumber(summary.brand, revealed.pan)}`
                : `${network} ending ${summary.last4}`}
            </span>
            {groups.map((group, index) => (
              <span key={index} aria-hidden="true">
                {group}
              </span>
            ))}
          </span>
          {onToggleReveal ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleReveal();
              }}
              aria-label={revealed ? "Hide card details" : "Show card details"}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white transition-colors"
            >
              {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          ) : (
            <span className="inline-flex size-6 shrink-0 items-center justify-center text-white/70">
              <Eye className="size-4" />
            </span>
          )}
        </span>

        <span data-slot="wallet-card-bottom" className="flex items-end justify-between gap-4">
          <FaceField
            slot="wallet-card-holder"
            caption="CARDHOLDER"
            value={revealed?.cardholderName ? revealed.cardholderName : summary.nickname || "IRFAN TAMBOLI"}
          />
          <FaceField slot="wallet-card-expiry" caption="EXPIRES" value={expiry} align="end" />
        </span>
        {children}
      </div>
    </div>
  );
}
