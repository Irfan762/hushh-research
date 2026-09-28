import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiJsonMock, nativePlatform } = vi.hoisted(() => ({
  apiJsonMock: vi.fn(),
  nativePlatform: { current: false },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => nativePlatform.current },
}));
vi.mock("@/lib/services/api-client", () => ({ apiJson: apiJsonMock }));

import {
  currentLegalDocumentVersions,
  LegalAcceptanceService,
} from "@/lib/services/legal-acceptance-service";
import { LEGAL_DOCUMENTS } from "@/lib/legal/legal-documents";

function user(uid: string) {
  return { uid, getIdToken: vi.fn().mockResolvedValue(`token-${uid}`) };
}

// The sign-in screen's "By continuing you agree to our Terms and Privacy
// Policy" is the acceptance. It is recorded silently on a successful sign-in;
// nothing re-prompts afterwards.
describe("LegalAcceptanceService.recordSignInAcceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativePlatform.current = false;
  });

  it("records the served Terms and Privacy versions for the signed-in person", async () => {
    apiJsonMock.mockResolvedValue({ acceptances: [] });

    await LegalAcceptanceService.recordSignInAcceptance(user("user-web"));

    expect(apiJsonMock).toHaveBeenCalledTimes(1);
    const [requestPath, init] = apiJsonMock.mock.calls[0];
    expect(requestPath).toBe("/api/account/legal-acceptance");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer token-user-web" });
    expect(JSON.parse(String(init.body))).toEqual({
      documents: currentLegalDocumentVersions(),
      surface: "web",
    });
    expect(currentLegalDocumentVersions()).toEqual([
      {
        document_id: "terms",
        document_version: LEGAL_DOCUMENTS.terms.version,
        effective_date: LEGAL_DOCUMENTS.terms.lastUpdated,
      },
      {
        document_id: "privacy",
        document_version: LEGAL_DOCUMENTS.privacy.version,
        effective_date: LEGAL_DOCUMENTS.privacy.lastUpdated,
      },
    ]);
  });

  it("labels a native sign-in as native", async () => {
    nativePlatform.current = true;
    apiJsonMock.mockResolvedValue({ acceptances: [] });

    await LegalAcceptanceService.recordSignInAcceptance(user("user-native"));

    expect(JSON.parse(String(apiJsonMock.mock.calls[0][1].body)).surface).toBe("native");
  });

  it("never throws, so a failed write cannot block sign-in", async () => {
    apiJsonMock.mockRejectedValue(new Error("offline"));

    await expect(
      LegalAcceptanceService.recordSignInAcceptance(user("user-offline")),
    ).resolves.toBeUndefined();
  });
});
