/**
 * Adds only the selected workflow's value-free field labels to a KYC answer
 * before the fixed-schema extractor sees it. A person commonly answers a
 * follow-up with a bare value (for example, an academic email address); the
 * label is necessary to distinguish that from their primary contact email.
 *
 * This is transient extraction context. Gmail content and the label itself
 * are never written to PKM; only an extractor-approved owner response is.
 */
export function buildKycFollowUpPkmSource(params: {
  ownerResponse: string;
  requestedFieldLabels?: readonly string[];
}): string {
  const ownerResponse = params.ownerResponse.trim();
  const labels = [...new Set(
    (params.requestedFieldLabels || [])
      .map((label) => label.trim())
      .filter(Boolean),
  )].slice(0, 8);

  if (!labels.length) return ownerResponse;
  return `KYC requested fields: ${labels.join("; ")}\nOwner response: ${ownerResponse}`;
}
