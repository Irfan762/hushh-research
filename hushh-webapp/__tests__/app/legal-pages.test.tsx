import { readFileSync } from "node:fs";
import path from "node:path";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PrivacyPolicyPage from "@/app/privacy/page";
import TermsOfUsePage from "@/app/terms/page";
import { AuthLegalDialog } from "@/components/onboarding/AuthLegalDialog";
import { LEGAL_DOCUMENTS } from "@/lib/legal/legal-documents";
import {
  ROUTES,
  isOnboardingAdmissionExemptRoute,
  isPublicRoute,
} from "@/lib/navigation/routes";

const REPO = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(REPO, file), "utf8");

// /privacy and /terms are the URLs given to the Google OAuth consent screen and
// the store listings, and the documents a person agrees to at sign-in. They
// must render signed out, and sign-in and Profile must reach them.
describe("Privacy Policy and Terms of Use pages", () => {
  it("are public and never held behind sign-in or setup", () => {
    expect(ROUTES.PRIVACY).toBe("/privacy");
    expect(ROUTES.TERMS).toBe("/terms");
    for (const route of [ROUTES.PRIVACY, ROUTES.TERMS]) {
      expect(isPublicRoute(route)).toBe(true);
      expect(isOnboardingAdmissionExemptRoute(route)).toBe(true);
    }
  });

  it("render the versioned, dated documents", () => {
    for (const [Page, doc] of [
      [PrivacyPolicyPage, LEGAL_DOCUMENTS.privacy],
      [TermsOfUsePage, LEGAL_DOCUMENTS.terms],
    ] as const) {
      const { unmount } = render(<Page />);
      expect(
        screen.getByRole("heading", { level: 1, name: doc.title }),
      ).toBeTruthy();
      expect(
        screen.getAllByText(
          `Last updated ${doc.lastUpdatedLabel} · Version ${doc.version}`,
        ).length,
      ).toBeGreaterThan(0);
      expect(doc.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      unmount();
    }
  });

  it("carries Google's Limited Use disclosure for restricted Gmail and Drive scopes", () => {
    render(<PrivacyPolicyPage />);
    const section = screen
      .getByRole("heading", {
        name: "Google API Services User Data Policy: Limited Use",
      })
      .closest("section") as HTMLElement;
    const policyLink = within(section).getByRole("link", {
      name: "Google API Services User Data Policy",
    });
    expect(policyLink.getAttribute("href")).toBe(
      "https://developers.google.com/terms/api-services-user-data-policy",
    );
    expect(section.textContent).toContain(
      "including the Limited Use requirements",
    );
    expect(section.textContent).toContain(
      "develop, improve, or train generalized AI or machine learning models",
    );
  });

  it("is what the sign-in sheet shows, with a link to the full page", () => {
    render(<AuthLegalDialog docType="privacy" onOpenChange={() => {}} />);
    expect(screen.getByText(LEGAL_DOCUMENTS.privacy.summary)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open full page" }).getAttribute("href"),
    ).toBe(ROUTES.PRIVACY);
    // The sheet no longer points at a separate document on another site.
    expect(read("components/onboarding/AuthLegalDialog.tsx")).not.toContain(
      "hushh.ai/privacy",
    );
  });

  it("are reachable from Profile", () => {
    const profile = read("components/profile/profile-workspace-page.tsx");
    expect(profile).toContain("router.push(ROUTES.PRIVACY)");
    expect(profile).toContain("router.push(ROUTES.TERMS)");
  });
});
