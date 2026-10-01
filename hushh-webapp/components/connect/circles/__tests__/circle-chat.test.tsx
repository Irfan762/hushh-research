// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/services/api-client";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { CircleChat } from "../circle-chat";

const api = vi.hoisted(() => ({ initialize: vi.fn(), state: vi.fn(), wait: vi.fn(), messages: vi.fn(), prepare: vi.fn(), send: vi.fn(), open: vi.fn(), read: vi.fn(), mute: vi.fn() }));
vi.mock("@/lib/services/circle-chat-service", () => ({ CircleChatService: api }));
type Observation = { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; target?: Element };
let observations: Observation[];
const session = { userId: "alice", circleId: "circle", vaultKey: "test-key", vaultOwnerToken: "test-token" };
const message = { id: "m1", sequence: 1, senderUserId: "bob", senderName: "Bob", createdAt: "2026-10-02T10:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks(); observations = [];
  vi.stubGlobal("IntersectionObserver", class {
    entry: Observation;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { this.entry = { callback, options }; observations.push(this.entry); }
    observe(target: Element) { this.entry.target = target; }
    disconnect() {}
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  api.initialize.mockResolvedValue(undefined);
  api.state.mockResolvedValue({ unreadCount: 1, latestSequence: 1, members: [], rosterVersion: "v", muted: false });
  api.wait.mockImplementation(() => new Promise(() => {}));
  api.messages.mockResolvedValue({ items: [message], hasMore: false });
  api.open.mockResolvedValue({ text: "Incoming private message", image: null });
  api.read.mockResolvedValue(undefined);
  appInteractionCoordinator.handleLifecycle("active");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); appInteractionCoordinator.handleLifecycle("active"); });

function observe(inViewport: boolean) {
  act(() => {
    for (const item of observations) item.callback([{ isIntersecting: item.options?.root ? true : inViewport, target: item.target } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

it("keeps an uncertain retry unchanged across collapse and clears plaintext on access loss", async () => {
  const sealed = { clientMessageId: "same-message-uuid", ciphertext: "opaque" };
  api.prepare.mockResolvedValue(sealed);
  api.send.mockRejectedValueOnce(new ApiError("Timed out", 504)).mockResolvedValueOnce({ ...message, id: "sent", sequence: 2, senderUserId: "alice" });
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(/Delivery is unconfirmed/);
  fireEvent.click(screen.getByRole("button", { name: /Circle chat/ }));
  fireEvent.click(screen.getByRole("button", { name: /Circle chat/ }));
  fireEvent.click(screen.getByRole("button", { name: "Retry message" }));
  await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(api.send.mock.calls[0]![1]).toBe(api.send.mock.calls[1]![1]);
  api.messages.mockRejectedValue(new ApiError("No longer available", 404, { detail: { code: "CIRCLE_CHAT_UNAVAILABLE" } }));
  act(() => window.dispatchEvent(new CustomEvent("hushh:circle-chat-changed", { detail: { userId: session.userId, circleId: session.circleId } })));
  await screen.findByText("You no longer have access to this circle chat.");
  expect(screen.queryByText("Incoming private message")).not.toBeInTheDocument();
});

it("acknowledges only a visible conversation in the foreground", async () => {
  render(<CircleChat session={session} circleName="Family" initialOpen />);
  await screen.findByText("Incoming private message");
  observe(false);
  await act(async () => {});
  expect(api.read).not.toHaveBeenCalled();
  act(() => appInteractionCoordinator.handleLifecycle("background"));
  observe(true);
  await act(async () => {});
  expect(api.read).not.toHaveBeenCalled();
  act(() => appInteractionCoordinator.handleLifecycle("active"));
  await waitFor(() => expect(api.read).toHaveBeenCalledWith(session, 1));
});
