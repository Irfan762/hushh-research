import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  vaultKey: null as string | null,
  handleApproveBundle: vi.fn(async () => undefined),
  handleDenyBundle: vi.fn(async () => undefined),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: mocks.vaultKey }),
}));

vi.mock("@/lib/consent/use-consent-actions", () => ({
  useConsentActions: () => ({
    handleApproveBundle: mocks.handleApproveBundle,
    handleDenyBundle: mocks.handleDenyBundle,
    bundleProgress: null,
  }),
}));

import { groupPendingConsentRequests } from "@/lib/consent/owner-consent-request";
import { useOwnerConsentDecision } from "@/lib/consent/use-owner-consent-decision";
import type { ConsentCenterEntry } from "@/lib/services/consent-center-service";

/**
 * Allow from the Feed with the vault locked.
 *
 * Allowing builds the encrypted export from the owner's memory ON THIS DEVICE,
 * so it needs the vault key. The old path answered a locked vault with a toast
 * that navigated away and dropped the decision. Now the unlock prompt opens,
 * nothing is sent while it is open, and the same decision runs once the key
 * arrives. Closing the prompt cancels it and nothing is sent at all.
 */

function request() {
  const entry: ConsentCenterEntry = {
    id: "req-1",
    request_id: "req-1",
    kind: "incoming_request",
    status: "pending",
    action: "REQUESTED",
    scope: "attr.food.preferences.*",
    counterpart_type: "person",
    counterpart_id: "user-kushal",
    counterpart_label: "Kushal Trivedi",
    reason: "Picking a place for our dinner together",
    issued_at: "1790000000000",
    metadata: { bundle_id: "bundle-dinner", expiry_hours: 168 },
  };
  return groupPendingConsentRequests([entry])[0]!;
}

describe("useOwnerConsentDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.vaultKey = null;
  });

  it("prompts the unlock first, sends nothing meanwhile, then allows through the shared path", async () => {
    const { result, rerender } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );

    let decided!: Promise<boolean>;
    act(() => {
      decided = result.current.allow(request());
    });

    expect(result.current.unlockPrompt.open).toBe(true);
    expect(result.current.unlockPrompt.title).toBe("Unlock to allow");
    expect(result.current.unlockPrompt.description).toContain("Food preferences");
    expect(mocks.handleApproveBundle).not.toHaveBeenCalled();

    // The vault opens: the waiting decision runs, once.
    mocks.vaultKey = "vault-key";
    rerender();

    await expect(decided).resolves.toBe(true);
    expect(mocks.handleApproveBundle).toHaveBeenCalledTimes(1);
    const [consents, options] = mocks.handleApproveBundle.mock.calls[0] as unknown as [
      Array<{ id: string; durationHours?: number; scope: string }>,
      { successMessage?: string },
    ];
    expect(consents.map((consent) => consent.id)).toEqual(["req-1"]);
    expect(consents[0]!.durationHours).toBe(168);
    expect(options.successMessage).toBe("Kushal can now see your Food preferences.");
    await waitFor(() => expect(result.current.unlockPrompt.open).toBe(false));
  });

  it("drops the decision when the unlock is closed", async () => {
    const { result } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );

    let decided!: Promise<boolean>;
    act(() => {
      decided = result.current.deny(request());
    });
    expect(result.current.unlockPrompt.title).toBe("Unlock to decline");

    act(() => {
      result.current.unlockPrompt.cancel();
    });

    await expect(decided).resolves.toBe(false);
    expect(result.current.unlockPrompt.open).toBe(false);
    expect(mocks.handleDenyBundle).not.toHaveBeenCalled();
    expect(mocks.handleApproveBundle).not.toHaveBeenCalled();
  });

  it("decides at once when the vault is already open", async () => {
    mocks.vaultKey = "vault-key";
    const { result } = renderHook(() =>
      useOwnerConsentDecision({ userId: "owner-1" }),
    );

    await act(async () => {
      await expect(result.current.deny(request())).resolves.toBe(true);
    });
    expect(result.current.unlockPrompt.open).toBe(false);
    expect(mocks.handleDenyBundle).toHaveBeenCalledWith(["req-1"], expect.any(Object));
  });
});
