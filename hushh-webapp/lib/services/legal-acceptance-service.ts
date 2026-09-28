// hushh-webapp/lib/services/legal-acceptance-service.ts
//
// Records which version of the Terms of Use and Privacy Policy a person
// accepted. The sign-in screen says "By continuing you agree to our Terms and
// Privacy Policy", with both linking to their full pages, so a successful
// sign-in is the acceptance and is recorded silently. There is no in-app
// re-acceptance prompt.
//
// The version identity is read from the legal document source, never typed
// here. `currentLegalDocumentVersions` is the single place that knows the
// source's shape.
import { Capacitor } from "@capacitor/core";
import type { User } from "firebase/auth";

import {
  LEGAL_DOCUMENTS,
  type LegalDocumentType,
} from "@/lib/legal/legal-documents";
import { apiJson } from "@/lib/services/api-client";

export type LegalAcceptanceDocumentId = LegalDocumentType;
export type LegalAcceptanceSurface = "web" | "native";

export type LegalDocumentVersion = {
  document_id: LegalAcceptanceDocumentId;
  document_version: string;
  effective_date: string;
};

export type LegalAcceptanceRecord = LegalDocumentVersion & {
  accepted_at: string;
  surface: LegalAcceptanceSurface;
};

export type LegalAcceptanceState = {
  acceptances: LegalAcceptanceRecord[];
};

const LEGAL_ACCEPTANCE_PATH = "/api/account/legal-acceptance";
const LEGAL_DOCUMENT_IDS: readonly LegalAcceptanceDocumentId[] = ["terms", "privacy"];

/** The version and effective date of each document the app serves right now. */
export function currentLegalDocumentVersions(): LegalDocumentVersion[] {
  return LEGAL_DOCUMENT_IDS.map((documentId) => {
    const document = LEGAL_DOCUMENTS[documentId];
    return {
      document_id: documentId,
      document_version: document.version,
      effective_date: document.lastUpdated,
    };
  });
}

export function currentLegalAcceptanceSurface(): LegalAcceptanceSurface {
  return Capacitor.isNativePlatform() ? "native" : "web";
}

type AuthUser = Pick<User, "uid" | "getIdToken">;

async function bearer(user: AuthUser): Promise<string> {
  const token = await user.getIdToken();
  if (!token) throw new Error("A signed-in session is required.");
  return token;
}

export const LegalAcceptanceService = {
  async recordAcceptance(user: AuthUser): Promise<LegalAcceptanceState> {
    const token = await bearer(user);
    const payload = await apiJson<Partial<LegalAcceptanceState> | undefined>(
      LEGAL_ACCEPTANCE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documents: currentLegalDocumentVersions(),
          surface: currentLegalAcceptanceSurface(),
        }),
      },
    );
    return { acceptances: Array.isArray(payload?.acceptances) ? payload.acceptances : [] };
  },

  /**
   * Record the sign-in screen's agreement once the sign-in succeeds. Never
   * throws: a failed write never blocks sign-in, and the next successful
   * sign-in records the served versions again (the write is idempotent per
   * version).
   */
  async recordSignInAcceptance(user: AuthUser): Promise<void> {
    await this.recordAcceptance(user).catch(() => undefined);
  },
};
