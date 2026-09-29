"use client";

/**
 * The secure "Shared with you" card with its on-device opening (CONTRACT-2
 * decision 2, C6). Chat renders it from One's card payload; Profile renders
 * one per person from the share list. Both pass the same `items`.
 *
 * Trust boundary: values are decrypted here with the person's own connector
 * key, kept only in this component's state, dropped when the vault locks,
 * the person changes, access ends or the export's window runs out, and never
 * written to storage, logs or the server.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import {
  openSharedItems,
  resolveSharedSensitivity,
  type SharedItemOpenResult,
} from "@/lib/consent/open-granted-person-information";
import type { SharedWithMeCardItem } from "@/lib/agent/agui-structured-experiences";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { AgentTranscriptRevealContext } from "@/components/agent/agent-transcript-reveal";
import {
  SharedWithYouCardView,
  type SharedWithYouCardStatus,
  type SharedWithYouItemView,
} from "./shared-with-you-card-view";

export type SharedWithYouPerson = {
  personRef: string;
  displayName: string;
  photoUrl?: string | null;
};

type Opened = {
  viewerUid: string;
  ownerToken: string;
  signature: string;
  results: SharedItemOpenResult[];
};

const OPEN_TIMEOUT_MS = 30_000;

function isPast(iso: string | null, nowMs: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms <= nowMs;
}

/** The card's own reading of one item, before any value is opened. */
export function sharedItemBaseView(item: SharedWithMeCardItem, nowMs: number): SharedWithYouItemView {
  const ended = item.status === "revoked" || item.status === "expired" || isPast(item.accessEndsAt, nowMs);
  return {
    key: item.key,
    label: item.label,
    sharedAt: item.sharedAt,
    accessEndsAt: item.accessEndsAt,
    purpose: item.purpose,
    sensitive: resolveSharedSensitivity({ sensitivity: item.sensitivity, domain: item.domain, label: item.label }) === "sensitive",
    fieldOutline: item.fieldOutline,
    state: ended ? "ended" : item.decryptable === false ? "unopenable" : "loading",
    endedReason: item.status === "revoked" ? "revoked" : "expired",
    endedAt: item.accessEndsAt,
  };
}

export function SharedWithYouCard({ person, items, variant = "chat", className }: {
  person: SharedWithYouPerson;
  items: SharedWithMeCardItem[];
  variant?: "chat" | "profile";
  className?: string;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const generation = useRef(0);
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const revealInTranscript = useContext(AgentTranscriptRevealContext);

  const baseItems = useMemo(() => items.map((item) => sharedItemBaseView(item, nowMs)), [items, nowMs]);
  const openable = useMemo(() => items.filter((_, index) => baseItems[index]!.state === "loading"), [items, baseItems]);
  const signature = useMemo(() => `${person.personRef}|${retry}|${openable.map((item) =>
    `${item.key}:${item.bundleId ?? ""}:${item.requestId ?? ""}`).join(",")}`, [person.personRef, retry, openable]);

  useEffect(() => {
    const token = generation.current + 1;
    generation.current = token;
    if (!isVaultUnlocked || !user?.uid || !vaultKey || !vaultOwnerToken || !openable.length) return;
    const viewerUid = user.uid;
    const ownerToken = vaultOwnerToken;
    setFailed(null);
    // A stalled connector or export never leaves the card on its skeleton.
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("timeout")), OPEN_TIMEOUT_MS);
    });
    void Promise.race([openSharedItems({
      userId: viewerUid,
      vaultKey,
      vaultOwnerToken: ownerToken,
      subjectRef: person.personRef,
      items: openable.map((item) => ({
        key: item.key, bundleId: item.bundleId, requestId: item.requestId,
        grantRef: item.grantRef, label: item.label, domain: item.domain,
      })),
      isCurrent: () => generation.current === token,
    }), timeout]).then((results) => {
      if (!results || generation.current !== token) return;
      if (results.every((result) => result.state === "unavailable")) {
        setOpened(null);
        setFailed(signature);
        return;
      }
      setOpened({ viewerUid, ownerToken, signature, results });
    }).catch(() => {
      if (generation.current === token) setFailed(signature);
    }).finally(() => window.clearTimeout(timer));
    return () => window.clearTimeout(timer);
  }, [isVaultUnlocked, user?.uid, vaultKey, vaultOwnerToken, person.personRef, openable, signature]);

  // A lock, a sign-out or a different person drops every opened value at once.
  useEffect(() => {
    if (!isVaultUnlocked) setOpened(null);
  }, [isVaultUnlocked]);

  // Access changing anywhere (a stop, a new approval) re-reads the ledger.
  useEffect(() => {
    const onChanged = () => setRetry((value) => value + 1);
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onChanged);
  }, []);

  const current = opened && isVaultUnlocked && opened.viewerUid === user?.uid
    && opened.ownerToken === vaultOwnerToken && opened.signature === signature ? opened : null;

  // Values leave memory the moment the export's window, or access, runs out.
  useEffect(() => {
    const ends = [
      ...(current?.results ?? []).flatMap((result) => result.state === "open" ? [result.expiresAtMs] : []),
      ...items.flatMap((item) => {
        const ms = item.accessEndsAt ? Date.parse(item.accessEndsAt) : Number.NaN;
        return Number.isFinite(ms) && ms > nowMs ? [ms] : [];
      }),
    ];
    if (!ends.length) return;
    const wait = Math.max(0, Math.min(...ends) - Date.now());
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(wait + 50, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [current, items, nowMs]);

  const status: SharedWithYouCardStatus = !isVaultUnlocked
    ? "locked"
    : !openable.length || current ? "ready" : failed === signature ? "error" : "loading";

  const views = baseItems.map((base): SharedWithYouItemView => {
    if (base.state === "ended" || base.state === "unopenable") return base;
    if (status === "locked") return { ...base, state: "locked" };
    const result = current?.results.find((entry) => entry.key === base.key);
    if (!result) return base;
    if (result.state === "ended") return { ...base, state: "ended", endedReason: "revoked", endedAt: null };
    if (result.state === "unavailable") return { ...base, state: "unavailable" };
    if (result.expiresAtMs <= nowMs) return { ...base, state: "ended", endedReason: "expired" };
    return {
      ...base,
      state: "ready",
      data: result.value.data,
      sensitive: base.sensitive || result.value.sensitivity === "sensitive",
    };
  });

  // In a live chat turn, bring the card above the composer once, when it
  // first appears. A restored conversation is left where the reader is.
  const [reveal] = useState(() => variant === "chat" ? revealInTranscript : null);
  useEffect(() => {
    const element = sectionRef.current;
    if (!reveal || !element?.closest('[data-message-status="streaming"]')) return;
    reveal(element);
  }, [reveal]);

  const onRetry = useCallback(() => setRetry((value) => value + 1), []);

  return (
    <div ref={sectionRef}>
      <SharedWithYouCardView
        person={{ displayName: person.displayName, photoUrl: person.photoUrl ?? null }}
        status={status}
        items={views}
        variant={variant}
        className={className}
        onRetry={onRetry}
        onUnlock={user ? () => setUnlockOpen(true) : undefined}
      />
      {user && status === "locked" ? (
        <VaultUnlockDialog
          user={user}
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          onSuccess={() => setUnlockOpen(false)}
          title="Unlock to view"
          description={`Unlock your vault to open what ${person.displayName} shared, on this device only.`}
        />
      ) : null}
    </div>
  );
}
