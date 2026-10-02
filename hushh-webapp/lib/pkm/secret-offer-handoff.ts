/**
 * Hands a Secrets item to the screen that files it, in memory only.
 *
 * "Add this card to Wallet" and "Add passport to Identity documents" open the
 * Wallet add form or the KYC screen through Next client navigation, which keeps
 * this module's state. What crosses is a reference (the owner and the secret
 * id), never the value, and never through the URL, history or storage: the
 * target screen decrypts the value from the vault itself, and the owner then
 * commits with that feature's own writer. A reload drops the offer, by design.
 */

export type SecretOfferTarget = "wallet" | "kyc_identity_documents";

type StagedSecretOffer = {
  ownerUserId: string;
  secretId: string;
  fileTo: SecretOfferTarget;
  expiresAt: number;
};

export const SECRET_OFFER_TTL_MS = 10 * 60 * 1_000;
const SECRET_ID = /^sec_[a-f0-9]{16}$/;

let staged: StagedSecretOffer | null = null;

export function stageSecretOffer(input: { ownerUserId: string; secretId: string; fileTo: SecretOfferTarget }): void {
  if (!input.ownerUserId || !SECRET_ID.test(input.secretId)) throw new Error("secret_offer_invalid");
  staged = { ...input, expiresAt: Date.now() + SECRET_OFFER_TTL_MS };
}

/** The staged offer for this owner and screen, if it is still fresh. */
export function peekSecretOffer(input: { ownerUserId: string | null | undefined; fileTo: SecretOfferTarget }): { secretId: string } | null {
  if (!staged) return null;
  if (staged.expiresAt <= Date.now()) {
    staged = null;
    return null;
  }
  if (!input.ownerUserId || staged.ownerUserId !== input.ownerUserId || staged.fileTo !== input.fileTo) return null;
  return { secretId: staged.secretId };
}

/** Drop the offer once the owner has filed it or turned it down. */
export function clearSecretOffer(): void {
  staged = null;
}
