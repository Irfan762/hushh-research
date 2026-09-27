import { describe, expect, it } from "vitest";

import { buildKycFollowUpPkmSource } from "@/lib/pkm/kyc-follow-up-context";

describe("buildKycFollowUpPkmSource", () => {
  it("keeps a bare academic email bound to the selected KYC field", () => {
    expect(buildKycFollowUpPkmSource({
      ownerResponse: "22b4513@iitb.ac.in",
      requestedFieldLabels: ["College email address"],
    })).toBe(
      "KYC requested fields: College email address\nOwner response: 22b4513@iitb.ac.in",
    );
  });

  it("does not add context when the workflow did not supply a field label", () => {
    expect(buildKycFollowUpPkmSource({
      ownerResponse: "22b4513@iitb.ac.in",
    })).toBe("22b4513@iitb.ac.in");
  });
});
