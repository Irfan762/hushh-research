import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ native: true, json: vi.fn() }));
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: () => mocks.native, getPlatform: () => mocks.native ? "ios" : "web" } };
});
vi.mock("@/lib/services/api-client", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/services/api-client")>(), apiJson: mocks.json }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: {} }));
vi.mock("@/lib/one-location/key-bootstrap", () => ({ bootstrapCurrentUserLocationRecipientKey: vi.fn() }));

import { CircleChatService } from "@/lib/services/circle-chat-service";

it("awaits a non-cancelable native wait through caller abort while still propagating web cancellation", async () => {
  let finish!: (value: unknown) => void;
  mocks.json.mockImplementation((_url, options: RequestInit) => new Promise((resolve, reject) => {
    finish = resolve;
    options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const session = { userId: "alice", circleId: "circle", vaultKey: "fixture", vaultOwnerToken: "fixture" };
  const nativeAbort = new AbortController();
  let settled = false;
  const native = CircleChatService.wait(session, 0, nativeAbort.signal).then(() => { settled = true; });
  nativeAbort.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  finish({ latestSequence: 1, changed: true });
  await native;
  mocks.native = false;
  const webAbort = new AbortController();
  const web = CircleChatService.wait(session, 1, webAbort.signal);
  webAbort.abort();
  await expect(web).rejects.toMatchObject({ name: "AbortError" });
});
