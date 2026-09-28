"use client";

// In-memory bookkeeping for information requests this person sent from One
// chat and is waiting on. It holds identifiers only (owner, bundle,
// conversation, the other person's public reference and display name), never
// shared values, and it is never written to storage. A reload rebuilds it from
// the conversation's own sealed history: every outgoing request card whose
// answer that conversation has not continued yet (`rebuildWaitingRequests`).

import { useMemo, useSyncExternalStore } from "react";

import {
  consentContinuationSentLabel,
  CONSENT_WIRE_OUTCOME,
  formatSharedInformationForAgent,
  isAccessEndedOutcome,
  isSharedOutcome,
  openGrantedPersonInformation,
  wireOutcomeForSentLabel,
  type ConsentContinuationWireOutcome,
  type ConsentOutcome,
} from "@/lib/consent/open-granted-person-information";
import type { AgentStructuredExperience } from "@/lib/agent/agui-structured-experiences";
import {
  getAgentChatConsentOutcomes,
  type AgentChatConsentContinuation,
} from "@/lib/services/agent-chat-client";

export type SentInformationRequest = {
  ownerId: string;
  bundleId: string;
  conversationId: string;
  subjectRef: string;
  personName: string;
  /** When this tab started waiting; the doorbell's fast window counts from here. */
  watchedAtMs?: number;
  /** Rebuilt from history after a reload rather than sent in this tab. */
  restored?: boolean;
};

const waiting = new Map<string, SentInformationRequest>();
const claimed = new Set<string>();
const listeners = new Set<() => void>();

function keyOf(ownerId: string, bundleId: string): string {
  return `${ownerId}:${bundleId.toLowerCase()}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** The chat card registers a request it shows as waiting on the other person. */
export function watchSentInformationRequest(request: SentInformationRequest): void {
  if (!request.ownerId || !request.bundleId || !request.conversationId) return;
  const key = keyOf(request.ownerId, request.bundleId);
  if (claimed.has(key)) return;
  const existing = waiting.get(key);
  waiting.set(key, {
    ...existing,
    ...request,
    // A request sent in this tab keeps its identity when history restores it.
    personName: request.personName || existing?.personName || "",
    restored: Boolean(existing ? existing.restored && request.restored : request.restored),
    watchedAtMs: existing?.watchedAtMs ?? request.watchedAtMs ?? Date.now(),
    bundleId: request.bundleId.toLowerCase(),
  });
  if (!existing) emit();
}

export function unwatchSentInformationRequest(ownerId: string, bundleId: string): void {
  if (waiting.delete(keyOf(ownerId, bundleId))) emit();
}

export function listSentInformationRequests(ownerId: string | null | undefined): SentInformationRequest[] {
  if (!ownerId) return [];
  return [...waiting.values()].filter((request) => request.ownerId === ownerId);
}

export function sentInformationRequest(
  ownerId: string,
  bundleId: string,
): SentInformationRequest | null {
  return waiting.get(keyOf(ownerId, bundleId)) ?? null;
}

/** The newest request's start: a fresh request earns the fast cadence again. */
export function newestWaitingSinceMs(ownerId: string | null | undefined): number | null {
  let newest: number | null = null;
  for (const request of listSentInformationRequests(ownerId)) {
    const since = request.watchedAtMs ?? null;
    if (since !== null && (newest === null || since > newest)) newest = since;
  }
  return newest;
}

export function subscribeSentInformationRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const armed = new Set<string>();
const mountedCards = new Map<string, number>();

/**
 * A chat card for this request is on screen and will continue it in place.
 * Returns the release for unmount.
 */
export function mountInformationRequestCard(ownerId: string, bundleId: string): () => void {
  const key = keyOf(ownerId, bundleId);
  mountedCards.set(key, (mountedCards.get(key) ?? 0) + 1);
  return () => {
    const count = (mountedCards.get(key) ?? 1) - 1;
    if (count <= 0) mountedCards.delete(key);
    else mountedCards.set(key, count);
  };
}

export function isInformationRequestCardMounted(ownerId: string, bundleId: string): boolean {
  return (mountedCards.get(keyOf(ownerId, bundleId)) ?? 0) > 0;
}

/** The person opened this answer from its notice: its chat may continue it. */
export function armConsentContinuation(ownerId: string, bundleId: string): void {
  armed.add(keyOf(ownerId, bundleId));
}

/** Waiting (sent here, or rebuilt from history), or opened from its notice. */
export function isConsentContinuationArmed(ownerId: string, bundleId: string): boolean {
  const key = keyOf(ownerId, bundleId);
  return waiting.has(key) || armed.has(key);
}

/**
 * Exactly one surface in this tab continues a given answer. The server also
 * refuses a second follow-up for the same bundle in the same conversation.
 */
export function claimConsentContinuation(ownerId: string, bundleId: string): boolean {
  const key = keyOf(ownerId, bundleId);
  if (claimed.has(key)) return false;
  claimed.add(key);
  armed.delete(key);
  if (waiting.delete(key)) emit();
  return true;
}

/** This tab is continuing (or has continued) this answer itself. */
export function isConsentContinuationClaimed(ownerId: string, bundleId: string): boolean {
  return claimed.has(keyOf(ownerId, bundleId));
}

/** A continuation that failed before the server admitted it may be retried. */
export function releaseConsentContinuation(ownerId: string, bundleId: string): void {
  claimed.delete(keyOf(ownerId, bundleId));
}

export function clearSentInformationRequests(keepOwnerId?: string | null): void {
  for (const [key, request] of waiting) {
    if (request.ownerId !== keepOwnerId) waiting.delete(key);
  }
  for (const set of [claimed, armed]) {
    for (const key of set) {
      if (!keepOwnerId || !key.startsWith(`${keepOwnerId}:`)) set.delete(key);
    }
  }
  for (const key of [...phases.keys()]) {
    if (!keepOwnerId || !key.startsWith(`${keepOwnerId}:`)) phases.delete(key);
  }
  emit();
  emitPhase();
}

// --- Card phase: "reading" the moment an answer is seen, "answered" after --

/**
 * Where the continuation for a request stands, for its card. "reading" is set
 * the moment the answer is detected, before One's reply streams; "answered"
 * once that reply is written. Null while nothing is continuing.
 */
export type InformationRequestContinuationPhase = "reading" | "answered";

const phases = new Map<string, InformationRequestContinuationPhase>();
const phaseListeners = new Set<() => void>();
/** Bumped on every phase change, so a reader over many cards re-renders. */
let phaseVersion = 0;

function emitPhase(): void {
  phaseVersion += 1;
  for (const listener of phaseListeners) listener();
}

export function setInformationRequestPhase(
  ownerId: string,
  bundleId: string,
  phase: InformationRequestContinuationPhase | null,
): void {
  if (!ownerId || !bundleId) return;
  const key = keyOf(ownerId, bundleId);
  if ((phases.get(key) ?? null) === phase) return;
  if (phase) phases.set(key, phase);
  else phases.delete(key);
  emitPhase();
}

export function informationRequestPhase(
  ownerId: string | null | undefined,
  bundleId: string | null | undefined,
): InformationRequestContinuationPhase | null {
  if (!ownerId || !bundleId) return null;
  return phases.get(keyOf(ownerId, bundleId)) ?? null;
}

function subscribePhase(listener: () => void): () => void {
  phaseListeners.add(listener);
  return () => phaseListeners.delete(listener);
}

/** The card's `phase`, live. */
export function useInformationRequestPhase(
  ownerId: string | null | undefined,
  bundleId: string | null | undefined,
): InformationRequestContinuationPhase | null {
  return useSyncExternalStore(
    subscribePhase,
    () => informationRequestPhase(ownerId, bundleId),
    () => null,
  );
}

/**
 * Every card's phase for one owner, live: the `(bundleId) => phase` reader the
 * chat provides as `ConsentCardPhaseContext`. Its identity changes whenever
 * any phase changes, so each card reading it re-renders.
 */
export function useInformationRequestPhaseReader(
  ownerId: string | null | undefined,
): (bundleId: string) => InformationRequestContinuationPhase | null {
  const version = useSyncExternalStore(subscribePhase, () => phaseVersion, () => 0);
  return useMemo(() => {
    void version;
    return (bundleId: string) => informationRequestPhase(ownerId, bundleId);
  }, [ownerId, version]);
}

// --- Doorbell: an adaptive check while a request waits and the chat shows --

/** About 2s while a request waits and the chat is visible. */
export const DOORBELL_FAST_INTERVAL_MS = 2_000;
/** How long the fast cadence lasts after the newest request started waiting. */
export const DOORBELL_FAST_WINDOW_MS = 120_000;
/** After the fast window: 4s, 8s, then every 15s. */
export const DOORBELL_BACKOFF_MS = [4_000, 8_000, 15_000] as const;

/** The wait before the next check, given how long the newest request has waited. */
export function doorbellDelayMs(waitedMs: number, backoffStep: number): number {
  if (waitedMs < DOORBELL_FAST_WINDOW_MS) return DOORBELL_FAST_INTERVAL_MS;
  return DOORBELL_BACKOFF_MS[Math.min(Math.max(0, backoffStep), DOORBELL_BACKOFF_MS.length - 1)]!;
}

export type InformationRequestDoorbell = {
  /** Check now and restart the cadence (a push, a live event, a new request). */
  ring: () => void;
  /** Visibility may have changed: resume with an instant check, or pause. */
  visibilityChanged: () => void;
  stop: () => void;
};

/**
 * Runs `check` on an adaptive cadence while `hasWaiting()` and `isVisible()`
 * both hold. Hidden means paused (no timer at all); becoming visible or
 * focused checks at once. Only the cadence lives here: the check itself is the
 * caller's, so the server calls stay exactly what they were.
 */
export function startInformationRequestDoorbell(input: {
  check: () => void;
  hasWaiting: () => boolean;
  waitingSinceMs: () => number | null;
  isVisible: () => boolean;
  now?: () => number;
  /** Listen to the page's own visibility and focus. Defaults to true. */
  listen?: boolean;
}): InformationRequestDoorbell {
  const now = input.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let backoffStep = 0;
  let anchor: number | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (stopped || !input.hasWaiting() || !input.isVisible()) return;
    const since = input.waitingSinceMs();
    if (since !== anchor) {
      anchor = since;
      backoffStep = 0;
    }
    const waited = since === null ? DOORBELL_FAST_WINDOW_MS : now() - since;
    const delay = doorbellDelayMs(waited, backoffStep);
    if (waited >= DOORBELL_FAST_WINDOW_MS) backoffStep += 1;
    timer = setTimeout(tick, delay);
  };

  function tick() {
    timer = null;
    if (stopped || !input.isVisible()) return;
    if (input.hasWaiting()) input.check();
    schedule();
  }

  const ring = () => {
    if (stopped) return;
    if (input.isVisible() && input.hasWaiting()) input.check();
    schedule();
  };

  const visibilityChanged = () => {
    if (stopped) return;
    if (input.isVisible()) ring();
    else clear();
  };

  const listen = input.listen ?? true;
  const onFocus = () => visibilityChanged();
  if (listen && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("focus", onFocus);
  }
  schedule();

  return {
    ring,
    visibilityChanged,
    stop: () => {
      stopped = true;
      clear();
      if (listen && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityChanged);
        window.removeEventListener("focus", onFocus);
      }
    },
  };
}

/** A rebuilt request answered long ago does not reopen an old chat by itself. */
export const RESTORED_ANSWER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the server says the answer came in too long ago to auto-continue. */
export function isStaleRestoredAnswer(bundle: unknown, nowMs: number = Date.now()): boolean {
  const progress = (bundle as { progress?: { decided_at?: unknown } } | null)?.progress;
  const decidedAt = typeof progress?.decided_at === "string" ? Date.parse(progress.decided_at) : NaN;
  return Number.isFinite(decidedAt) && nowMs - decidedAt > RESTORED_ANSWER_MAX_AGE_MS;
}

// --- Durable waiting and answer tags, rebuilt from the conversation ---------

export type OutgoingRequestCard = {
  messageId: string;
  bundleId: string;
  subjectRef: string;
  personName: string;
  labels: string[];
};

type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  kind?: "selection";
  /** Set on the live chip and answer; restored from history metadata when the server tags it. */
  consentBundleId?: string;
  structuredExperiences?: Array<{ experience: AgentStructuredExperience | { type: string } }>;
};

/** Outgoing request cards this conversation sent, in transcript order. */
export function collectOutgoingRequestCards(messages: readonly TranscriptMessage[]): OutgoingRequestCard[] {
  const cards: OutgoingRequestCard[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const entry of message.structuredExperiences ?? []) {
      const experience = entry.experience as AgentStructuredExperience;
      if (experience.type !== "one.information_request_review.v1") continue;
      if (experience.direction !== "outgoing" || experience.phase !== "submitted") continue;
      if (!experience.bundleId || !experience.subjectRef) continue;
      const bundleId = experience.bundleId.toLowerCase();
      if (seen.has(bundleId)) continue;
      seen.add(bundleId);
      cards.push({
        messageId: message.id,
        bundleId,
        subjectRef: experience.subjectRef,
        personName: experience.personName,
        labels: experience.fields.map((field) => field.label).filter(Boolean),
      });
    }
  }
  return cards;
}

/**
 * The durable waiting set after a reload: every outgoing request card in this
 * conversation whose answer the conversation has not continued yet. The
 * server's one-time marker (`hussh:consent_outcome:<bundle>`, surfaced as
 * `consentOutcomes`) is what "continued" means, so a second device or a second
 * tab never continues the same answer twice.
 */
export function rebuildWaitingRequests(input: {
  ownerId: string;
  conversationId: string;
  cards: readonly OutgoingRequestCard[];
  continued: Readonly<Record<string, string>>;
  nowMs?: number;
}): SentInformationRequest[] {
  const continued = new Set(Object.keys(input.continued).map((bundleId) => bundleId.toLowerCase()));
  return input.cards
    .filter((card) => !continued.has(card.bundleId))
    .map((card) => ({
      ownerId: input.ownerId,
      bundleId: card.bundleId,
      conversationId: input.conversationId,
      subjectRef: card.subjectRef,
      personName: card.personName,
      watchedAtMs: input.nowMs ?? Date.now(),
      restored: true,
    }));
}

function isKnownWireOutcome(value: string): value is ConsentContinuationWireOutcome {
  return Object.prototype.hasOwnProperty.call(CONSENT_WIRE_OUTCOME, value);
}

export type ConsentTranscriptTag = {
  bundleId: string;
  /** The outcome this conversation continued with, as the server recorded it. */
  continuedOutcome: ConsentContinuationWireOutcome;
  role: "chip" | "answer";
};

/**
 * Which messages belong to which request's continuation: the outcome chip and
 * One's answer after it. A server tag (`metadata.consentBundleId`) wins; a
 * chip without one is matched to the first card, in transcript order, whose
 * recorded outcome it carries and that no earlier chip claimed.
 */
export function tagConsentContinuationMessages(input: {
  messages: readonly TranscriptMessage[];
  cards: readonly OutgoingRequestCard[];
  continued: Readonly<Record<string, string>>;
}): Map<string, ConsentTranscriptTag> {
  const tags = new Map<string, ConsentTranscriptTag>();
  const continued = new Map(
    Object.entries(input.continued).map(([bundleId, outcome]) => [bundleId.toLowerCase(), outcome]),
  );
  const assigned = new Set<string>();
  let current: { bundleId: string; continuedOutcome: ConsentContinuationWireOutcome } | null = null;
  for (const message of input.messages) {
    if (message.role === "user") {
      current = null;
      const outcome = message.kind === "selection" ? wireOutcomeForSentLabel(message.text) : null;
      if (!outcome) continue;
      // A server tag wins, even for a bundle continued twice (an answer, then
      // the end of that access).
      const tagged = message.consentBundleId?.toLowerCase();
      const bundleId = tagged
        ? tagged
        : input.cards.find((card) => !assigned.has(card.bundleId)
          && continued.get(card.bundleId) === outcome)?.bundleId;
      if (!bundleId) continue;
      assigned.add(bundleId);
      current = { bundleId, continuedOutcome: outcome };
      tags.set(message.id, { ...current, role: "chip" });
      continue;
    }
    const serverTag = message.consentBundleId?.toLowerCase();
    if (serverTag) {
      const recorded = continued.get(serverTag);
      const continuedOutcome = recorded && isKnownWireOutcome(recorded)
        ? recorded
        : current?.bundleId === serverTag ? current.continuedOutcome : "granted";
      tags.set(message.id, { bundleId: serverTag, continuedOutcome, role: "answer" });
      continue;
    }
    if (current) tags.set(message.id, { ...current, role: "answer" });
  }
  return tags;
}

/**
 * Answers to hide as "Access ended": One's answer from shared information
 * whose sharing has since been stopped or has run out. A declined or expired
 * request never carried shared information, so its answer stays.
 */
export function redactedConsentAnswers(input: {
  tags: ReadonlyMap<string, ConsentTranscriptTag>;
  liveOutcomes: Readonly<Record<string, ConsentOutcome | null | undefined>>;
  /** Message ids the server already marked as redacted. */
  serverRedacted?: ReadonlySet<string>;
}): Set<string> {
  const hidden = new Set<string>(input.serverRedacted ?? []);
  for (const [messageId, tag] of input.tags) {
    if (tag.role !== "answer" || !isSharedOutcome(tag.continuedOutcome)) continue;
    if (isAccessEndedOutcome(input.liveOutcomes[tag.bundleId])) hidden.add(messageId);
  }
  return hidden;
}

// --- The follow-up turn -----------------------------------------------------

/**
 * Whether another device (or tab) already continued this answer in its
 * conversation. The server's one-time marker is the authority, so a refused
 * second continuation is a settled answer, not an error.
 */
export async function continuedElsewhere(input: {
  conversationId: string;
  bundleId: string;
  vaultOwnerToken: string;
  vaultKey: string;
}): Promise<boolean> {
  const done = await getAgentChatConsentOutcomes({
    conversationId: input.conversationId,
    vaultOwnerToken: input.vaultOwnerToken,
    vaultKey: input.vaultKey,
  }).catch(() => null);
  return Boolean(done && input.bundleId.toLowerCase() in done);
}


/**
 * Build the follow-up turn's request. For an approval the shared information
 * is decrypted on this device and passed only as this turn's text. The
 * message is the server's fixed label for the outcome, never display copy.
 */
export async function prepareConsentContinuation(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  bundleId: string;
  subjectRef: string;
  outcome: ConsentOutcome;
  domainFor?: (requestId: string) => string | null | undefined;
  isCurrent?: () => boolean;
}): Promise<{
  message: string;
  continuation: AgentChatConsentContinuation;
  sharedLabels: string[];
} | null> {
  const message = consentContinuationSentLabel(input.outcome);
  const wire = CONSENT_WIRE_OUTCOME[input.outcome];
  if (!isSharedOutcome(wire)) {
    return { message, continuation: { bundleId: input.bundleId, outcome: wire }, sharedLabels: [] };
  }
  const opened = await openGrantedPersonInformation(input);
  if (!opened) return null;
  const sharedInformation = formatSharedInformationForAgent(opened.values);
  if (!sharedInformation) throw new Error("Nothing readable was shared.");
  return {
    message,
    continuation: { bundleId: input.bundleId, outcome: wire, sharedInformation },
    sharedLabels: opened.values.map((value) => value.label),
  };
}

/**
 * Bring One's continuation reply into view above the composer and bottom bar.
 * The transcript's follow effect reads these two flags: the reader is no
 * longer treated as browsing history, and the next render reveals the pending
 * reply the same way a sent message does.
 */
export function revealConsentContinuationReply(refs: {
  userScrolled: { current: boolean };
  scrollToSubmittedTurn: { current: boolean };
}): void {
  refs.userScrolled.current = false;
  refs.scrollToSubmittedTurn.current = true;
}
