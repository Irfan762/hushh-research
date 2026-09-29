import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OWNER = "owner-1";

const mocks = vi.hoisted(() => ({
  getInformationRequest: vi.fn(),
  streamAgentChat: vi.fn(),
  getAgentChatConsentOutcomes: vi.fn(),
  toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: OWNER } }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: "vault-key", getVaultOwnerToken: () => "owner-token" }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/elsewhere",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  appInteractionCoordinator: {
    getLifecycleSnapshot: () => ({ state: "active" }),
    subscribeLifecycle: () => () => undefined,
  },
}));
vi.mock("@/lib/agent/agent-chat-history-events", () => ({ dispatchAgentChatHistoryInvalidated: vi.fn() }));
vi.mock("@/lib/agent/agent-chat-turn-watch", () => ({
  requestOpenAgentConversation: vi.fn(),
  settleWatchedAgentTurn: vi.fn(),
  watchDetachedAgentTurn: vi.fn(),
}));
vi.mock("@/lib/agent/in-app-chat-selection", () => ({ rememberInAppChat: vi.fn() }));
vi.mock("@/lib/services/agent-chat-client", () => ({
  findInformationRequestConversation: vi.fn(async () => null),
  streamAgentChat: mocks.streamAgentChat,
  getAgentChatConsentOutcomes: mocks.getAgentChatConsentOutcomes,
}));
vi.mock("@/lib/services/person-profile-service", () => ({
  PersonProfileService: { getInformationRequest: mocks.getInformationRequest },
}));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {} }));

import { AgentConsentContinuationNotifier } from "@/components/agent/agent-consent-continuation-notifier";
import {
  clearSentInformationRequests,
  informationRequestPhase,
  listSentInformationRequests,
  markConsentContinuationUnavailable,
  watchSentInformationRequest,
} from "@/lib/agent/consent-continuation";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";

function bundle(status: "pending" | "denied") {
  return {
    personRef: "person-kushal",
    bundleId: BUNDLE,
    purpose: "Plan dinner",
    durationSeconds: 604_800,
    cancelled: false,
    items: [{ requestId: "r1", scopeRef: "s1", label: "Food preferences", sensitivity: null, status }],
  };
}

function waitOnKushal() {
  watchSentInformationRequest({
    ownerId: OWNER,
    bundleId: BUNDLE,
    conversationId: "conversation-1",
    subjectRef: "person-kushal",
    personName: "Kushal",
  });
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("AgentConsentContinuationNotifier doorbell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.getInformationRequest.mockReset();
    mocks.streamAgentChat.mockReset();
    mocks.getAgentChatConsentOutcomes.mockReset();
    mocks.toast.mockClear();
    mocks.toast.error.mockClear();
    mocks.toast.dismiss.mockClear();
  });
  afterEach(() => {
    clearSentInformationRequests(null);
    vi.useRealTimers();
  });

  it("checks about every 2s while a request waits, with the same server call", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("pending"));
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(1);
    expect(mocks.getInformationRequest).toHaveBeenCalledWith({ bundleId: BUNDLE, vaultOwnerToken: "owner-token" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    // A flat 8s poll would have made one call here, not four.
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(5);
  });

  it("checks at once on a push or live event for the waiting request", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("pending"));
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(1);
    act(() => {
      dispatchConsentStateChanged({
        source: "information_request_updated",
        bundleId: BUNDLE,
        requestId: "r1",
        action: "CONSENT_GRANTED",
      });
    });
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and checks at once when the app shows again", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    mocks.getInformationRequest.mockResolvedValue(bundle("pending"));
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(1);

    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(mocks.getInformationRequest).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("treats a continuation another device already gave as handled: no error toast", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("denied"));
    // The server refuses the second continuation (409 "already continued").
    mocks.streamAgentChat.mockRejectedValue(new Error("This conversation already continued after that answer."));
    mocks.getAgentChatConsentOutcomes.mockResolvedValue({ [BUNDLE]: "denied" });
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    await flush();

    expect(mocks.streamAgentChat).toHaveBeenCalledWith(expect.objectContaining({
      message: "Request declined",
      consentContinuation: { bundleId: BUNDLE, outcome: "denied" },
    }));
    // The person sees what happened in words, never the fixed label.
    expect(mocks.toast).toHaveBeenCalledWith("Kushal declined", expect.anything());
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.dismiss).toHaveBeenCalledWith(`consent-outcome-${BUNDLE}`);
    expect(informationRequestPhase(OWNER, BUNDLE)).toBe("answered");
  });

  // Regression (localhost run 2026-09-28): the receipt was refused (404), so
  // the follow-up turn got 409 and "One couldn't complete that response".
  it("never starts a follow-up the server would refuse for a request without a receipt", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("denied"));
    waitOnKushal();
    markConsentContinuationUnavailable(OWNER, BUNDLE);
    render(<AgentConsentContinuationNotifier />);
    await flush();
    await flush();
    expect(mocks.streamAgentChat).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    // It stops waiting: no endless polling of a settled request.
    expect(listSentInformationRequests(OWNER)).toEqual([]);
  });

  it("control: a failure nobody else answered still says so", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("denied"));
    mocks.streamAgentChat.mockRejectedValue(new Error("offline"));
    mocks.getAgentChatConsentOutcomes.mockResolvedValue({});
    waitOnKushal();
    render(<AgentConsentContinuationNotifier />);
    await flush();
    await flush();
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(informationRequestPhase(OWNER, BUNDLE)).toBeNull();
  });
});
