import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InformationRequestReviewExperience, ScopeDiscoveryExperience } from "@/lib/agent/agui-structured-experiences";
import type { ViewerPersonProfile } from "@/lib/services/person-profile-service";

const mocks = vi.hoisted(() => ({
  user: { uid: "requester-a", getIdToken: vi.fn(async () => "test-token") },
  unlocked: true, getViewer: vi.fn(), create: vi.fn(), getInformationRequest: vi.fn(),
  getInformationRequestExports: vi.fn(), readStoredConnector: vi.fn(), decryptScopedExport: vi.fn(),
  searchScopeCatalog: vi.fn(),
}));
vi.mock("@/lib/services/agent-chat-client", () => ({ getAgentChatConsentOutcomes: async () => ({}) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: mocks.unlocked, vaultKey: "test-key", vaultOwnerToken: "test-owner-token" }) }));
vi.mock("@/lib/services/person-profile-service", async importOriginal => ({
  ...await importOriginal<object>(),
  PersonProfileService: {
    getViewer: mocks.getViewer, createInformationRequest: mocks.create,
    getInformationRequest: mocks.getInformationRequest, getInformationRequestExports: mocks.getInformationRequestExports,
    searchScopeCatalog: mocks.searchScopeCatalog,
  },
}));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {
  ensureConnector: async () => ({ connector_key_id: "test-connector" }),
  readStoredConnector: mocks.readStoredConnector,
  decryptScopedExport: mocks.decryptScopedExport,
} }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, variant: _variant, size: _size, ...props }: { children: ReactNode; variant?: string; size?: string }) => <button {...props}>{children}</button> }));
vi.mock("@/lib/morphy-ux/ui/surface-primitives", () => ({
  SectionCard: ({ children, title }: { children: ReactNode; title: string }) => <section><h4>{title}</h4>{children}</section>,
  StatusPill: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/consent/consent-scope-nested-list", () => ({
  ConsentScopeNestedList: ({ items }: { items: Array<{ id: string; label: string }> }) =>
    <div>{items.map(item => <span key={item.id}>{item.label}</span>)}</div>,
}));

import { AgentStructuredExperienceView } from "@/components/agent/agent-structured-experience";
import { ConsentCardPhaseContext, RequesterProgressBody } from "@/components/agent/consent/requester-consent-card";
import { AccessEndedNotice } from "@/components/agent/consent/access-ended-notice";
import { SharedDetailsList, humanSharedDetails } from "@/components/agent/consent/shared-details";
import { parseRequestProgress, timelineFor, type RequestProgress } from "@/components/agent/consent/request-progress";
import { askSentence } from "@/components/agent/consent/ask-proposal-card";
import { parseScopeProposal } from "@/lib/agent/scope-proposal";
import { parseAgentToolResultExperience } from "@/lib/agent/agui-structured-experiences";
import { DecryptedRecordContent } from "@/components/connections/decrypted-grant-card";
import { clearSentInformationRequests } from "@/lib/agent/consent-continuation";

const ASKED = "2026-09-28T13:49:00Z";
const ENDS = "2026-10-05T12:00:00Z";

function progress(overrides: Partial<Record<string, unknown>> = {}): RequestProgress {
  const parsed = parseRequestProgress({
    requested_at: ASKED, delivered_at: null, seen_at: null, decided_at: null,
    outcome: "pending", access_ends_at: null, ended_at: null,
    fields: [{ scope: "attr.food.preferences.*", label: "Food preferences", status: "pending" }],
    ...overrides,
  });
  if (!parsed) throw new Error("fixture progress did not parse");
  return parsed;
}

function stateOf(steps: ReturnType<typeof timelineFor>) {
  return Object.fromEntries(steps.map(step => [step.key, `${step.state}:${step.label}`]));
}

/** Memory tree exactly as the baseline screenshot rendered it raw. */
const MEMORY_TREE = {
  preferences: { entities: {
    food_preferences: {
      kind: "preference", status: "active",
      summary: "My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings.",
      observations: ["My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings."],
    },
    mem_65725402299c: {
      kind: "preference", status: "active", summary: "Favorite restaurant is Nopa in San Francisco.",
      created_at: "2026-09-20T10:00:00Z", entity_id: "0f8c2a1e-5b6d-4c3e-9a7b-1d2e3f4a5b6c",
    },
  } },
};

function assertNoInternalIds(root: HTMLElement) {
  const text = root.textContent ?? "";
  for (const pattern of [/mem[\s_-]?65725402299c/i, /\bkind\b/i, /\bstatus\b/i, /\bentities\b/i, /0f8c2a1e/i, /2026-09-20/]) {
    if (pattern.test(text)) throw new Error(`internal detail rendered: ${pattern}`);
  }
}

describe("request progress timeline", () => {
  it("rejects missing or malformed progress so older backends keep today's card", () => {
    expect(parseRequestProgress(undefined)).toBeNull();
    expect(parseRequestProgress({ outcome: "granted" })).toBeNull();
    expect(parseRequestProgress({ requested_at: ASKED, outcome: "maybe" })).toBeNull();
  });

  it("walks Asked, Delivered, Seen, Decided with exactly one live step while waiting", () => {
    expect(stateOf(timelineFor(progress()))).toMatchObject({ asked: "done:Asked", delivered: "current:Delivered", seen: "upcoming:Seen" });
    expect(stateOf(timelineFor(progress({ delivered_at: ASKED })))).toMatchObject({ delivered: "done:Delivered", seen: "current:Seen" });
    expect(stateOf(timelineFor(progress({ delivered_at: ASKED, seen_at: ASKED })))).toMatchObject({ seen: "done:Seen", decided: "current:Decided" });
    for (const p of [progress(), progress({ delivered_at: ASKED }), progress({ delivered_at: ASKED, seen_at: ASKED })]) {
      expect(timelineFor(p).filter(step => step.state === "current")).toHaveLength(1);
    }
  });

  it("marks a decision done and only pulses Reading when the chat says so", () => {
    const granted = progress({ decided_at: ASKED, outcome: "granted", access_ends_at: ENDS,
      fields: [{ label: "Food preferences", status: "granted" }] });
    const idle = stateOf(timelineFor(granted));
    expect(idle).toMatchObject({ delivered: "done:Delivered", seen: "done:Seen", decided: "done:Shared", reading: "upcoming:Reading" });
    expect(timelineFor(granted).some(step => step.state === "current")).toBe(false);
    expect(stateOf(timelineFor(granted, "reading"))).toMatchObject({ reading: "current:Reading", answered: "upcoming:Answered" });
    expect(timelineFor(granted, "answered").every(step => step.state === "done")).toBe(true);
  });

  it("skips Reading for a decline and for an unanswered expiry", () => {
    const denied = timelineFor(progress({ decided_at: ASKED, outcome: "denied", fields: [{ label: "Food preferences", status: "denied" }] }));
    expect(denied.map(step => step.key)).toEqual(["asked", "delivered", "seen", "decided", "answered"]);
    expect(denied.find(step => step.key === "decided")).toMatchObject({ label: "Declined", tone: "neutral" });
    const lapsed = stateOf(timelineFor(progress({ outcome: "expired", delivered_at: ASKED })));
    expect(lapsed).toMatchObject({ seen: "upcoming:Seen", decided: "done:No answer" });
  });
});

describe("living requester card body", () => {
  afterEach(cleanup);

  it("pulses the current step only through motion-safe, so reduced motion stays still", () => {
    render(<RequesterProgressBody progress={progress({ delivered_at: ASKED })} personName="Kushal Trivedi" purpose="Dinner" />);
    const pulse = screen.getByTestId("timeline-pulse");
    expect(pulse.className).toContain("motion-safe:animate-pulse");
    expect(pulse.className.split(/\s+/)).not.toContain("animate-pulse");
    expect(screen.getByRole("list", { name: "Request progress" }).querySelector("[aria-current='step']"))
      .toHaveAttribute("data-step", "seen");
    expect(screen.getByRole("status")).toHaveTextContent("Delivered to Kushal");
  });

  it("lists shared and declined items with human labels and when access ends", () => {
    const partial = progress({ decided_at: ASKED, outcome: "partially_granted", access_ends_at: ENDS, fields: [
      { label: "Food preferences", status: "granted" }, { label: "Health notes", status: "denied" },
    ] });
    render(<RequesterProgressBody progress={partial} personName="Kushal Trivedi" purpose="Dinner"
      details={<button type="button">View shared information</button>} />);
    expect(screen.getByRole("status")).toHaveTextContent("Kushal shared some of what you asked");
    const body = screen.getByTestId("requester-progress");
    expect(body).toHaveTextContent("Shared Food preferences");
    expect(body).toHaveTextContent("Not shared Health notes");
    expect(within(screen.getByRole("list", { name: "Request progress" })).getByText("Shared")).toBeInTheDocument();
    expect(screen.getByText("Access ends Oct 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View shared information" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/scope|grant|attr\./i);
  });

  it("replaces the shared details with Access ended after a revoke", () => {
    const revoked = progress({ decided_at: ASKED, outcome: "revoked", ended_at: "2026-09-29T12:00:00Z",
      fields: [{ label: "Food preferences", status: "revoked" }] });
    render(<RequesterProgressBody progress={revoked} personName="Kushal Trivedi" purpose="Dinner"
      details={<div data-testid="chat-shared-information">Nopa</div>} />);
    expect(screen.getByTestId("access-ended-notice"))
      .toHaveTextContent("Kushal stopped sharing Food preferences. One no longer uses it.");
    expect(screen.queryByTestId("chat-shared-information")).toBeNull();
    expect(document.body.textContent).not.toContain("Nopa");
  });

  it("words an expiry after sharing as ended on a day", () => {
    render(<AccessEndedNotice personName="Kushal Trivedi" labels={["Food preferences"]} reason="expired" endedAt={ENDS} />);
    expect(screen.getByTestId("access-ended-notice"))
      .toHaveTextContent("Access to Food preferences from Kushal ended Oct 5. One no longer uses it.");
  });
});

describe("human-readable shared details", () => {
  afterEach(cleanup);

  it("renders label and value rows, never ids, kinds or statuses", () => {
    const rows = humanSharedDetails(MEMORY_TREE, "Food preferences");
    expect(rows).toEqual([
      { label: "Food preferences", values: ["My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings."] },
      { label: "Preferences", values: ["Favorite restaurant is Nopa in San Francisco."] },
    ]);
    const view = render(<SharedDetailsList values={[{ requestId: "r1", label: "Food preferences", data: MEMORY_TREE }]} />);
    expect(screen.getByTestId("chat-shared-information")).toHaveTextContent("Neapolitan pizza");
    expect(() => assertNoInternalIds(view.container)).not.toThrow();
  });

  it("negative control: the same check fails on the raw tree renderer", () => {
    const raw = render(<DecryptedRecordContent data={MEMORY_TREE} />);
    expect(() => assertNoInternalIds(raw.container)).toThrow(/internal detail rendered/);
  });

  it("collapses long values behind Show more", () => {
    const long = "Vegetarian ".repeat(30).trim();
    render(<SharedDetailsList values={[{ requestId: "r1", label: "Diet", data: { diet: long } }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });
});

const person = "1234567890abcdef";
const bundleId = "bundle_12345678";
const requestId = "request_12345678";
const restored: InformationRequestReviewExperience = {
  type: "one.information_request_review.v1", personName: "Kushal Trivedi",
  purpose: "Picking a place for our dinner together", durationLabel: "7 days",
  direction: "outgoing", phase: "submitted", subjectRef: person, bundleId, requestId: null, status: "pending",
  fields: [{ label: "Preferences", domain: "Lifestyle", sensitivity: "standard", requestId }],
};
function bundle(status: "pending" | "granted" | "revoked", withProgress: boolean) {
  return {
    personRef: person, bundleId, purpose: restored.purpose, durationSeconds: 168 * 3600, cancelled: false,
    items: [{ requestId, scopeRef: "scope-food", label: "Preferences", sensitivity: "standard", status }],
    ...(withProgress ? { progress: {
      requested_at: ASKED, delivered_at: ASKED, seen_at: status === "pending" ? null : ASKED,
      decided_at: status === "pending" ? null : ASKED,
      outcome: status, access_ends_at: status === "granted" ? ENDS : null,
      ended_at: status === "revoked" ? "2026-09-29T12:00:00Z" : null,
      fields: [{ scope: "attr.food.preferences.*", label: "Food preferences", status }],
    } } : {}),
  };
}

describe("InformationRequestReviewView with and without progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSentInformationRequests();
    mocks.unlocked = true;
  });
  afterEach(cleanup);

  it("falls back to today's card when the server sends no progress", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("pending", false));
    render(<AgentStructuredExperienceView experience={restored} />);
    expect(await screen.findByText("Waiting for Kushal Trivedi's approval")).toBeInTheDocument();
    expect(screen.queryByTestId("request-timeline")).toBeNull();
  });

  it("renders the living card from progress and takes the phase from the chat", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("granted", true));
    render(<ConsentCardPhaseContext.Provider value={(id) => id === bundleId ? "reading" : null}>
      <AgentStructuredExperienceView experience={restored} />
    </ConsentCardPhaseContext.Provider>);
    const card = await screen.findByTestId("requester-progress");
    expect(card).toHaveAttribute("data-phase", "reading");
    expect(within(card).getByRole("status")).toHaveTextContent("Reading what Kushal shared…");
    expect(screen.getByText("Food preferences from Kushal Trivedi")).toBeInTheDocument();
    expect(screen.getByText("Access ends Oct 5")).toBeInTheDocument();
    expect(card.querySelector("[aria-current='step']")).toHaveAttribute("data-step", "reading");
  });

  it("drops revealed values and shows Access ended when the owner revokes", async () => {
    mocks.getInformationRequest.mockResolvedValue(bundle("granted", true));
    mocks.getInformationRequestExports.mockResolvedValue([{
      requestId, scopeRef: "scope-food",
      encryptedExport: {
        request_id: requestId, scope: "attr.food.preferences.*", export_revision: 1,
        export_envelope: { version: 2, export_id: "export-1", aad: {
          version: 2, app_id: "agent_one", grant_id: requestId, export_id: "export-1",
          revision: 1, machine_scope: "attr.food.preferences.*", scope_handle: "scope-handle",
          recipient_key_fingerprint: "fingerprint", payload_algorithm: "AES-256-GCM",
          expires_at_ms: Date.now() + 3600_000,
        } },
      },
    }]);
    mocks.readStoredConnector.mockResolvedValue({ connector_key_id: "test-connector" });
    mocks.decryptScopedExport.mockResolvedValue(MEMORY_TREE);
    render(<AgentStructuredExperienceView experience={restored} />);
    fireEvent.click(await screen.findByRole("button", { name: "View shared information" }));
    const details = await screen.findByTestId("chat-shared-information");
    expect(details).toHaveTextContent("Nopa");
    expect(() => assertNoInternalIds(details)).not.toThrow();

    mocks.getInformationRequest.mockResolvedValue(bundle("revoked", true));
    act(() => window.dispatchEvent(new Event("consent-state-changed")));
    expect(await screen.findByTestId("access-ended-notice"))
      .toHaveTextContent("Kushal stopped sharing Food preferences. One no longer uses it.");
    expect(screen.queryByTestId("chat-shared-information")).toBeNull();
    expect(document.body.textContent).not.toContain("Nopa");
  });
});

function viewer(): ViewerPersonProfile {
  return { personRef: person, displayName: "Kushal Trivedi", photoUrl: null, verifiedRole: null,
    relationship: { status: "connected", connectionId: "c", connectedAt: null, requestId: null },
    grants: [], requestHistory: [], requestableScopes: [
      { scopeRef: "scope-food", label: "Food preferences", description: null, domain: "lifestyle", sensitivity: "standard", wildcard: false },
    ],
  };
}
const discovery: ScopeDiscoveryExperience = {
  type: "one.scope_discovery.v1",
  person: { personRef: person, displayName: "Kushal Trivedi", profilePath: `/people/${person}`, relationship: "connected" },
  domainFilter: null, scopes: [],
};
const proposal = { proposed: [{ scopeRef: "scope-food", label: "Food preferences", why: "You asked where to eat." }],
  durationHours: 168, reasonSuggestion: "dinner planning" };

describe("One picks, you confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unlocked = true;
    mocks.getViewer.mockResolvedValue(viewer());
    mocks.create.mockResolvedValue({ personRef: person, bundleId, purpose: "dinner planning", durationSeconds: 168 * 3600,
      cancelled: false, items: [{ requestId, scopeRef: "scope-food", label: "Food preferences", sensitivity: "standard", status: "pending" }] });
    mocks.getInformationRequest.mockResolvedValue(bundle("pending", true));
    mocks.searchScopeCatalog.mockResolvedValue({ scopes: [
      { scopeRef: "scope-restaurants", label: "Favorite restaurants", description: null, domain: "lifestyle", sensitivity: null, wildcard: false },
    ], page: 1, hasMore: false, nextPage: null, totalCount: 1 });
  });
  afterEach(cleanup);

  it("parses the server proposal and phrases it as one sentence", () => {
    const parsed = parseScopeProposal({ person: "kushal", proposed: [{ scope: "scope-food", label: "Food preferences", why: "x" }],
      duration_default: "7d", reason_suggestion: "dinner planning" });
    expect(parsed).toEqual({ proposed: [{ scopeRef: "scope-food", label: "Food preferences", why: "x" }], durationHours: 168, reasonSuggestion: "dinner planning" });
    expect(askSentence("Kushal Trivedi", ["Food preferences"], 168, "dinner planning"))
      .toBe("Ask Kushal for Food preferences · 7 days · for dinner planning");
    expect(parseScopeProposal({ proposed: [] })).toBeNull();
    const experience = parseAgentToolResultExperience("propose_information_request", {
      status: "ok", person: discovery.person, requestableScopes: [],
      proposed: [{ scope: "scope-food", label: "Food preferences", why: null }], duration_default: 168, reason_suggestion: "dinner planning",
    });
    expect(experience).toMatchObject({ type: "one.scope_discovery.v1", proposal: { durationHours: 168 } });
  });

  it("sends One's pick through the existing send path", async () => {
    const onSubmitted = vi.fn(async () => undefined);
    render(<AgentStructuredExperienceView experience={{ ...discovery, proposal }} onInformationRequestSubmitted={onSubmitted} />);
    expect(screen.getByTestId("ask-sentence")).toHaveTextContent("Ask Kushal for Food preferences · 7 days · for dinner planning");
    const send = await screen.findByRole("button", { name: "Send" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      personRef: person, scopeRefs: ["scope-food"], purpose: "dinner planning", durationSeconds: 168 * 3600,
    })));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ bundleId, subjectRef: person })));
    expect(await screen.findByTestId("request-timeline")).toBeInTheDocument();
  });

  it("opens a server-searched picker behind Change and updates the sentence", async () => {
    render(<AgentStructuredExperienceView experience={{ ...discovery, proposal }} />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(mocks.searchScopeCatalog).toHaveBeenCalledWith(expect.objectContaining({ personRef: person, query: "", page: 1 })));
    fireEvent.change(screen.getByLabelText("Search what Kushal can share"), { target: { value: "restaurant" } });
    await waitFor(() => expect(mocks.searchScopeCatalog).toHaveBeenCalledWith(expect.objectContaining({ query: "restaurant", page: 1 })));
    fireEvent.click(await screen.findByRole("button", { name: "Favorite restaurants" }));
    expect(screen.getByTestId("ask-sentence")).toHaveTextContent("Ask Kushal for Food preferences and Favorite restaurants · 7 days");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("falls back to the catalog when there is no proposal", async () => {
    render(<AgentStructuredExperienceView experience={discovery} />);
    expect(screen.queryByTestId("ask-proposal-card")).toBeNull();
    expect(await screen.findByRole("button", { name: "Review request" })).toBeInTheDocument();
  });
});
