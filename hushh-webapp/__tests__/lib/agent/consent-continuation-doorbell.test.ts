import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimConsentContinuation,
  clearSentInformationRequests,
  collectOutgoingRequestCards,
  DOORBELL_FAST_WINDOW_MS,
  informationRequestPhase,
  isConsentContinuationArmed,
  isStaleRestoredAnswer,
  listSentInformationRequests,
  rebuildWaitingRequests,
  redactedConsentAnswers,
  revealConsentContinuationReply,
  setInformationRequestPhase,
  startInformationRequestDoorbell,
  tagConsentContinuationMessages,
  watchSentInformationRequest,
  type InformationRequestDoorbell,
} from "@/lib/agent/consent-continuation";
import {
  CONSENT_OUTCOME_LABELS,
  CONSENT_WIRE_OUTCOME,
  consentContinuationSentLabel,
  consentOutcomeDisplayText,
  informationRequestOutcome,
  type ConsentOutcome,
} from "@/lib/consent/open-granted-person-information";
import { parseConsentAccess } from "@/lib/services/agent-chat-client";

const OWNER = "owner-1";
const BUNDLE_A = "0f0e0d0c-0b0a-4908-8706-050403020100";
const BUNDLE_B = "1f1e1d1c-1b1a-4918-9716-151413121110";

/** Seconds (from start) at which `check` ran over the first `untilMs`. */
function checkTimes(
  start: (input: {
    check: () => void;
    hasWaiting: () => boolean;
    waitingSinceMs: () => number | null;
    isVisible: () => boolean;
  }) => { stop: () => void },
  untilMs: number,
): number[] {
  const startedAt = Date.now();
  const times: number[] = [];
  const doorbell = start({
    check: () => times.push((Date.now() - startedAt) / 1000),
    hasWaiting: () => true,
    waitingSinceMs: () => startedAt,
    isVisible: () => true,
  });
  vi.advanceTimersByTime(untilMs);
  doorbell.stop();
  return times;
}

/** The contract: about every 2s while waiting, then 4s, 8s and a 15s cap. */
function expectAdaptiveCadence(times: number[]): void {
  // Fast window: a check every 2s for the first two minutes.
  expect(times.slice(0, 5)).toEqual([2, 4, 6, 8, 10]);
  expect(times.filter((t) => t <= 120)).toHaveLength(60);
  // After two minutes: +4s, +8s, then +15s steps, never slower than 15s.
  const after = times.filter((t) => t >= 120);
  expect(after.slice(0, 5)).toEqual([120, 124, 132, 147, 162]);
  const gaps = after.slice(1).map((t, index) => t - after[index]!);
  expect(Math.max(...gaps)).toBe(15);
}

/** A negative control: the old fixed 8s poll, which the contract must reject. */
function startFlatEightSecondPoll(input: { check: () => void }): { stop: () => void } {
  const id = setInterval(input.check, 8_000);
  return { stop: () => clearInterval(id) };
}

describe("information request doorbell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    clearSentInformationRequests(null);
  });

  it("checks every 2s while a request waits, then backs off to 4s, 8s and a 15s cap", () => {
    const times = checkTimes((input) => startInformationRequestDoorbell({ ...input, listen: false }), 200_000);
    expectAdaptiveCadence(times);
  });

  it("negative control: a flat 8s poll fails the same cadence check", () => {
    const times = checkTimes(startFlatEightSecondPoll, 200_000);
    expect(times.slice(0, 3)).toEqual([8, 16, 24]);
    expect(() => expectAdaptiveCadence(times)).toThrow();
  });

  it("sets no timer at all while nothing waits", () => {
    const check = vi.fn();
    const doorbell = startInformationRequestDoorbell({
      check,
      hasWaiting: () => false,
      waitingSinceMs: () => null,
      isVisible: () => true,
      listen: false,
    });
    vi.advanceTimersByTime(60_000);
    expect(check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    doorbell.stop();
  });

  it("pauses while the page is hidden and checks at once when it shows again", () => {
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const check = vi.fn();
    const startedAt = Date.now();
    const doorbell = startInformationRequestDoorbell({
      check,
      hasWaiting: () => true,
      waitingSinceMs: () => startedAt,
      isVisible: () => document.visibilityState !== "hidden",
    });
    vi.advanceTimersByTime(4_000);
    expect(check).toHaveBeenCalledTimes(2);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(check).toHaveBeenCalledTimes(2);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    // Instant, not after the next interval.
    expect(check).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(2_000);
    expect(check).toHaveBeenCalledTimes(4);

    // Focus also resumes at once.
    window.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledTimes(5);
    doorbell.stop();
    spy.mockRestore();
  });

  it("rings instantly and restarts the cadence from that check", () => {
    const check = vi.fn();
    const startedAt = Date.now();
    let doorbell: InformationRequestDoorbell | null = null;
    doorbell = startInformationRequestDoorbell({
      check,
      hasWaiting: () => true,
      waitingSinceMs: () => startedAt,
      isVisible: () => true,
      listen: false,
    });
    vi.advanceTimersByTime(1_000);
    doorbell.ring();
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_999);
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(check).toHaveBeenCalledTimes(2);
    doorbell.stop();
  });

  it("gives a newly sent request the fast cadence again after a backoff", () => {
    const check = vi.fn();
    let since = Date.now();
    const doorbell = startInformationRequestDoorbell({
      check,
      hasWaiting: () => true,
      waitingSinceMs: () => since,
      isVisible: () => true,
      listen: false,
    });
    vi.advanceTimersByTime(DOORBELL_FAST_WINDOW_MS + 30_000);
    since = Date.now();
    doorbell.ring();
    check.mockClear();
    vi.advanceTimersByTime(6_000);
    expect(check).toHaveBeenCalledTimes(3);
    doorbell.stop();
  });
});

describe("durable waiting after a reload", () => {
  afterEach(() => clearSentInformationRequests(null));

  const card = (bundleId: string, personName: string, labels: string[]) => ({
    id: `msg-${bundleId}`,
    role: "assistant" as const,
    text: "",
    structuredExperiences: [{
      experience: {
        type: "one.information_request_review.v1" as const,
        personName,
        purpose: "Plan dinner",
        durationLabel: "7 days",
        direction: "outgoing" as const,
        phase: "submitted" as const,
        subjectRef: `person-${personName}`,
        bundleId,
        requestId: null,
        status: "pending" as const,
        fields: labels.map((label) => ({ label, domain: "food", sensitivity: "standard" as const })),
      },
    }],
  });

  it("rebuilds the waiting set from saved outgoing cards not yet continued", () => {
    // The in-memory set is empty, as after a reload.
    expect(listSentInformationRequests(OWNER)).toEqual([]);
    const messages = [
      { id: "u1", role: "user" as const, text: "Ask Kushal about food" },
      card(BUNDLE_A, "Kushal", ["Food preferences"]),
      card(BUNDLE_B, "Maya", ["Travel"]),
    ];
    const cards = collectOutgoingRequestCards(messages);
    expect(cards.map((entry) => entry.bundleId)).toEqual([BUNDLE_A, BUNDLE_B]);

    // BUNDLE_B was already continued (the server's one-time marker).
    const rebuilt = rebuildWaitingRequests({
      ownerId: OWNER,
      conversationId: "conversation-1",
      cards,
      continued: { [BUNDLE_B]: "granted" },
    });
    expect(rebuilt.map((request) => request.bundleId)).toEqual([BUNDLE_A]);
    for (const request of rebuilt) watchSentInformationRequest(request);

    expect(listSentInformationRequests(OWNER)).toEqual([
      expect.objectContaining({ bundleId: BUNDLE_A, conversationId: "conversation-1", personName: "Kushal", restored: true }),
    ]);
    // Rebuilt means armed: the card continues the answer that landed while closed.
    expect(isConsentContinuationArmed(OWNER, BUNDLE_A)).toBe(true);
    expect(isConsentContinuationArmed(OWNER, BUNDLE_B)).toBe(false);
  });

  it("never re-arms an answer this tab already claimed", () => {
    expect(claimConsentContinuation(OWNER, BUNDLE_A)).toBe(true);
    watchSentInformationRequest({
      ownerId: OWNER, bundleId: BUNDLE_A, conversationId: "c", subjectRef: "s", personName: "Kushal", restored: true,
    });
    expect(isConsentContinuationArmed(OWNER, BUNDLE_A)).toBe(false);
  });

  it("leaves an answer decided long ago alone", () => {
    const now = Date.parse("2026-09-28T10:00:00Z");
    expect(isStaleRestoredAnswer({ progress: { decided_at: "2026-09-01T10:00:00Z" } }, now)).toBe(true);
    expect(isStaleRestoredAnswer({ progress: { decided_at: "2026-09-27T10:00:00Z" } }, now)).toBe(false);
    expect(isStaleRestoredAnswer({}, now)).toBe(false);
  });
});

describe("outcome chip: human display, fixed sent label", () => {
  const consentContinuationPy = readFileSync(
    path.resolve(__dirname, "../../../../consent-protocol/hushh_mcp/one_adk/consent_continuation.py"),
    "utf8",
  );
  const serverLabels = Object.fromEntries(
    [...(consentContinuationPy.match(/CONSENT_OUTCOME_LABELS[^{]*\{([^}]*)\}/)?.[1] ?? "")
      .matchAll(/"([a-z_]+)":\s*"([^"]+)"/g)]
      .map((match) => [match[1], match[2]]),
  ) as Record<string, string>;

  it("sends exactly the server's admission labels", () => {
    expect(Object.keys(serverLabels).length).toBeGreaterThanOrEqual(5);
    expect(serverLabels).toEqual(CONSENT_OUTCOME_LABELS);
    for (const [outcome, label] of Object.entries(CONSENT_OUTCOME_LABELS)) {
      expect(serverLabels[outcome]).toBe(label);
    }
    const outcomes: ConsentOutcome[] = ["granted", "partially_granted", "denied", "expired", "revoked"];
    for (const outcome of outcomes) {
      const sent = consentContinuationSentLabel(outcome);
      const wire = CONSENT_WIRE_OUTCOME[outcome];
      // Whatever the server admits for an outcome it knows, the client sends verbatim.
      expect(sent).toBe(serverLabels[outcome] ?? serverLabels[wire]);
      expect(Object.values(serverLabels)).toContain(sent);
    }
  });

  it("guards integration: a new server outcome must be sent as itself", () => {
    // When the server learns partially_granted or revoked, its bundle_outcome
    // reports them, so the client must send them as themselves, not mapped.
    for (const outcome of ["partially_granted", "revoked"] as const) {
      if (serverLabels[outcome]) expect(CONSENT_WIRE_OUTCOME[outcome]).toBe(outcome);
    }
  });

  it("shows people what happened in words", () => {
    expect(consentOutcomeDisplayText({ outcome: "granted", personName: "Kushal", sharedLabels: ["Food preferences"] }))
      .toBe("Kushal shared Food preferences");
    expect(consentOutcomeDisplayText({ outcome: "denied", personName: "Kushal" })).toBe("Kushal declined");
    expect(consentOutcomeDisplayText({ outcome: "expired", personName: "Kushal" })).toBe("Kushal's request expired");
    expect(consentOutcomeDisplayText({ outcome: "partially_granted", personName: "Kushal", sharedLabels: ["Food preferences"] }))
      .toBe("Kushal shared Food preferences and declined the rest");
    expect(consentOutcomeDisplayText({ outcome: "revoked", personName: "Kushal", sharedLabels: ["Food preferences", "Travel", "Music"] }))
      .toBe("Kushal stopped sharing Food preferences, Travel and Music");
    // Display copy is never what is sent.
    expect(consentOutcomeDisplayText({ outcome: "granted", personName: "Kushal", sharedLabels: ["Food preferences"] }))
      .not.toBe(consentContinuationSentLabel("granted"));
    for (const outcome of ["granted", "partially_granted", "denied", "expired", "revoked"] as const) {
      const text = consentOutcomeDisplayText({ outcome, personName: "Kushal", sharedLabels: ["Food preferences"] });
      expect(text).not.toMatch(/—|PKM|grant|scope/i);
    }
  });

  it("reads partial and revoked outcomes, and prefers the server's progress outcome", () => {
    const item = (status: "granted" | "denied" | "revoked" | "expired" | "pending") => ({
      requestId: status, scopeRef: "s", label: status, sensitivity: null, status,
    });
    expect(informationRequestOutcome({ cancelled: false, items: [item("granted")] })).toBe("granted");
    expect(informationRequestOutcome({ cancelled: false, items: [item("granted"), item("denied")] })).toBe("partially_granted");
    expect(informationRequestOutcome({ cancelled: false, items: [item("revoked")] })).toBe("revoked");
    expect(informationRequestOutcome({ cancelled: false, items: [item("expired")] })).toBe("expired");
    expect(informationRequestOutcome({ cancelled: false, items: [item("granted"), item("pending")] })).toBeNull();
    expect(informationRequestOutcome({
      cancelled: false,
      items: [item("granted")],
      progress: { outcome: "revoked" },
    } as Parameters<typeof informationRequestOutcome>[0])).toBe("revoked");
    // Every rich outcome travels as itself: the server's progress.outcome
    // distinguishes them and admission refuses a mapped one.
    expect(CONSENT_WIRE_OUTCOME.partially_granted).toBe("partially_granted");
    expect(CONSENT_WIRE_OUTCOME.revoked).toBe("revoked");
  });
});

describe("continuation answers and access ended", () => {
  const cardMessage = (bundleId: string) => ({
    id: `card-${bundleId}`,
    role: "assistant" as const,
    text: "",
    structuredExperiences: [{
      experience: {
        type: "one.information_request_review.v1" as const,
        personName: "Kushal",
        purpose: "Plan dinner",
        durationLabel: "7 days",
        direction: "outgoing" as const,
        phase: "submitted" as const,
        subjectRef: "person-kushal",
        bundleId,
        requestId: null,
        status: "granted" as const,
        fields: [{ label: "Food preferences", domain: "food", sensitivity: "standard" as const }],
      },
    }],
  });

  it("tags the chip and One's answer with the bundle, then hides only shared answers on revoke", () => {
    const messages = [
      cardMessage(BUNDLE_A),
      cardMessage(BUNDLE_B),
      { id: "chip-a", role: "user" as const, kind: "selection" as const, text: "Consent approved" },
      { id: "answer-a", role: "assistant" as const, text: "Kushal likes Thai food." },
      { id: "chip-b", role: "user" as const, kind: "selection" as const, text: "Request declined" },
      { id: "answer-b", role: "assistant" as const, text: "Kushal declined." },
      { id: "later", role: "user" as const, text: "Thanks" },
      { id: "later-answer", role: "assistant" as const, text: "Anytime." },
    ];
    const cards = collectOutgoingRequestCards(messages);
    const tags = tagConsentContinuationMessages({
      messages,
      cards,
      continued: { [BUNDLE_A]: "granted", [BUNDLE_B]: "denied" },
    });
    expect(tags.get("chip-a")).toEqual({ bundleId: BUNDLE_A, continuedOutcome: "granted", role: "chip" });
    expect(tags.get("answer-a")).toEqual({ bundleId: BUNDLE_A, continuedOutcome: "granted", role: "answer" });
    expect(tags.get("answer-b")).toEqual({ bundleId: BUNDLE_B, continuedOutcome: "denied", role: "answer" });
    expect(tags.has("later-answer")).toBe(false);

    // While sharing holds, nothing is hidden.
    expect(redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_A]: "granted" } }).size).toBe(0);
    // Revoked: One's answer from it is hidden; the declined answer and chips stay.
    const hidden = redactedConsentAnswers({
      tags,
      liveOutcomes: { [BUNDLE_A]: "revoked", [BUNDLE_B]: "expired" },
    });
    expect([...hidden]).toEqual(["answer-a"]);
    // Expired access hides it too.
    expect([...redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_A]: "expired" } })]).toEqual(["answer-a"]);
  });

  it("uses the server's bundle tag and redaction flag when present", () => {
    const messages = [
      cardMessage(BUNDLE_A),
      cardMessage(BUNDLE_B),
      { id: "chip", role: "user" as const, kind: "selection" as const, text: "Consent approved", consentBundleId: BUNDLE_B },
      { id: "answer", role: "assistant" as const, text: "From Kushal", consentBundleId: BUNDLE_B },
    ];
    const tags = tagConsentContinuationMessages({
      messages,
      cards: collectOutgoingRequestCards(messages),
      continued: { [BUNDLE_A]: "granted", [BUNDLE_B]: "granted" },
    });
    expect(tags.get("answer")?.bundleId).toBe(BUNDLE_B);
    expect([...redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_B]: "revoked" } })]).toEqual(["answer"]);
    expect([...redactedConsentAnswers({ tags, liveOutcomes: {}, serverRedacted: new Set(["answer"]) })])
      .toEqual(["answer"]);
  });

  it("hides every server-tagged answer from a partial approval, and a second chip for the same bundle", () => {
    // Lane A tags EVERY answer while access was live, then "Access ended" may
    // continue the same bundle once more.
    const messages = [
      cardMessage(BUNDLE_A),
      { id: "chip", role: "user" as const, kind: "selection" as const, text: "Partly approved", consentBundleId: BUNDLE_A },
      { id: "answer-1", role: "assistant" as const, text: "From Kushal", consentBundleId: BUNDLE_A },
      { id: "ask-again", role: "user" as const, text: "And dessert?" },
      { id: "answer-2", role: "assistant" as const, text: "Still from Kushal", consentBundleId: BUNDLE_A },
      { id: "ended-chip", role: "user" as const, kind: "selection" as const, text: "Access ended", consentBundleId: BUNDLE_A },
    ];
    const tags = tagConsentContinuationMessages({
      messages,
      cards: collectOutgoingRequestCards(messages),
      continued: { [BUNDLE_A]: "partially_granted" },
    });
    expect(tags.get("chip")).toEqual({ bundleId: BUNDLE_A, continuedOutcome: "partially_granted", role: "chip" });
    expect(tags.get("ended-chip")).toEqual({ bundleId: BUNDLE_A, continuedOutcome: "revoked", role: "chip" });
    expect([...redactedConsentAnswers({ tags, liveOutcomes: { [BUNDLE_A]: "revoked" } })].sort())
      .toEqual(["answer-1", "answer-2"]);
  });

  it("reads the server's consentAccess names and labels, with the response map as the reason", () => {
    const access = parseConsentAccess(
      { bundleId: BUNDLE_A, state: "ended", outcome: null, personName: "Kushal Trivedi", labels: ["Food preferences", 7] },
      { [BUNDLE_A]: "expired" },
    );
    expect(access).toEqual({
      bundleId: BUNDLE_A, state: "ended", outcome: "expired", personName: "Kushal Trivedi", labels: ["Food preferences"],
    });
    expect(parseConsentAccess({ bundleId: BUNDLE_A, state: "live", outcome: null, personName: null, labels: [] }))
      .toMatchObject({ state: "live", outcome: null });
    expect(parseConsentAccess({ state: "ended" })).toBeUndefined();
    expect(parseConsentAccess("ended")).toBeUndefined();
  });
});

describe("continuation presentation", () => {
  afterEach(() => clearSentInformationRequests(null));

  it("moves the card from reading to answered", () => {
    expect(informationRequestPhase(OWNER, BUNDLE_A)).toBeNull();
    setInformationRequestPhase(OWNER, BUNDLE_A, "reading");
    expect(informationRequestPhase(OWNER, BUNDLE_A)).toBe("reading");
    setInformationRequestPhase(OWNER, BUNDLE_A, "answered");
    expect(informationRequestPhase(OWNER, BUNDLE_A)).toBe("answered");
    clearSentInformationRequests("someone-else");
    expect(informationRequestPhase(OWNER, BUNDLE_A)).toBeNull();
  });

  it("brings the reply into view even after the reader scrolled up", () => {
    const refs = { userScrolled: { current: true }, scrollToSubmittedTurn: { current: false } };
    revealConsentContinuationReply(refs);
    expect(refs).toEqual({ userScrolled: { current: false }, scrollToSubmittedTurn: { current: true } });
  });
});
