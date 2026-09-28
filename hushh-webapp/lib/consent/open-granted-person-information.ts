import { isCurrentPersonExport } from "@/lib/consent/person-export-binding";
import { projectGrantPayload } from "@/lib/consent/project-grant-payload";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import {
  PersonProfileService,
  type InformationRequestBundle,
} from "@/lib/services/person-profile-service";

export type OpenedPersonInformation = {
  requestId: string;
  label: string;
  data: Record<string, unknown>;
};

/**
 * Open what another person approved for this requester, on this device only.
 *
 * The export was encrypted by the owner's browser to this person's connector
 * key; the private half of that key lives inside their own vault. Every step
 * re-reads the ledger, checks that the export still matches the approved item,
 * and re-checks the grant after decrypting, so a revocation mid-open wins. The
 * result stays in memory; nothing here writes or logs it.
 */
export async function openGrantedPersonInformation(input: {
  userId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  bundleId: string;
  subjectRef: string;
  domainFor?: (requestId: string) => string | null | undefined;
  isCurrent?: () => boolean;
}): Promise<{ values: OpenedPersonInformation[]; expiresAtMs: number } | null> {
  const current = input.isCurrent ?? (() => true);
  const bundle = await PersonProfileService.getInformationRequest({
    bundleId: input.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  if (bundle.bundleId !== input.bundleId || bundle.personRef !== input.subjectRef) {
    throw new Error("Mismatched request");
  }
  const granted = bundle.items.filter((item) => item.status === "granted");
  if (!granted.length) throw new Error("No current grant");
  const connector = await OneKycClientZkService.readStoredConnector({
    userId: input.userId,
    vaultKey: input.vaultKey,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  if (!connector) throw new Error("Connection unavailable");
  const exports = await PersonProfileService.getInformationRequestExports({
    bundleId: bundle.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  const values: OpenedPersonInformation[] = [];
  let expiresAtMs = Number.MAX_SAFE_INTEGER;
  for (const item of granted) {
    const exact = exports.find((entry) => entry.requestId === item.requestId);
    if (!exact || !isCurrentPersonExport({
      item,
      scopeRef: exact.scopeRef,
      exportPackage: exact.encryptedExport,
      nowMs: Date.now(),
    })) {
      throw new Error("Export unavailable or changed");
    }
    const payload = await OneKycClientZkService.decryptScopedExport({
      exportPackage: exact.encryptedExport,
      connector,
    });
    if (!current()) return null;
    values.push({
      requestId: item.requestId,
      label: item.label,
      data: projectGrantPayload(payload, input.domainFor?.(item.requestId)),
    });
    expiresAtMs = Math.min(expiresAtMs, exact.encryptedExport.export_envelope.aad.expires_at_ms);
  }
  const latest = await PersonProfileService.getInformationRequest({
    bundleId: bundle.bundleId,
    vaultOwnerToken: input.vaultOwnerToken,
  });
  if (!current()) return null;
  if (
    latest.bundleId !== bundle.bundleId ||
    latest.personRef !== input.subjectRef ||
    !values.every((value) =>
      latest.items.some((item) => item.requestId === value.requestId && item.status === "granted"),
    )
  ) {
    throw new Error("Grant changed while opening information");
  }
  return { values, expiresAtMs };
}

const MAX_SHARED_TEXT_CHARS = 12_000;

function humanKey(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function appendLines(lines: string[], value: unknown, path: string[]): void {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value)) {
    const scalars = value.filter((entry) => typeof entry !== "object" || entry === null);
    if (scalars.length === value.length) {
      lines.push(`- ${path.join(" > ")}: ${scalars.map(String).join(", ")}`);
      return;
    }
    value.forEach((entry, index) => appendLines(lines, entry, [...path, String(index + 1)]));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // Internal bookkeeping keys are not part of what was shared.
      if (key.startsWith("_")) continue;
      appendLines(lines, entry, [...path, humanKey(key)]);
    }
    return;
  }
  lines.push(`- ${path.join(" > ")}: ${String(value)}`);
}

/**
 * The plain text One reads for the one follow-up turn: each approved item as
 * "Label > path: value" lines, bounded to the server's accepted size.
 */
export function formatSharedInformationForAgent(values: OpenedPersonInformation[]): string {
  const lines: string[] = [];
  for (const value of values) appendLines(lines, value.data, [value.label]);
  let text = "";
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > MAX_SHARED_TEXT_CHARS) break;
    text = next;
  }
  return text;
}

/**
 * The answer a chat reports once the other person decides (contract C3).
 * `partially_granted` means some of what was asked was shared and some was
 * not; `revoked` means sharing was stopped, which is distinct from a request
 * or access window that simply ran out (`expired`).
 */
export type ConsentOutcome = "granted" | "partially_granted" | "denied" | "expired" | "revoked";

const CONSENT_OUTCOMES: ReadonlySet<string> = new Set<ConsentOutcome>([
  "granted",
  "partially_granted",
  "denied",
  "expired",
  "revoked",
]);

/**
 * The outcomes the server's continuation admission accepts as the turn's
 * outcome: all five, each as itself (`CONSENT_OUTCOME_LABELS` in
 * `consent_continuation.py`).
 */
export type ConsentContinuationWireOutcome = ConsentOutcome;

/**
 * The fixed text of the follow-up turn, sent as its message. It MUST equal
 * `CONSENT_OUTCOME_LABELS` in `consent-protocol/hushh_mcp/one_adk/consent_continuation.py`:
 * admission refuses a follow-up whose message is anything else. People never
 * read this text; the chip shows `consentOutcomeDisplayText` instead.
 */
export const CONSENT_OUTCOME_LABELS: Record<ConsentContinuationWireOutcome, string> = {
  granted: "Consent approved",
  partially_granted: "Partly approved",
  denied: "Request declined",
  expired: "Request expired",
  revoked: "Access ended",
};

/**
 * How each outcome travels to the server: as itself. Admission compares the
 * sent outcome with the ledger's own `progress.outcome`, which distinguishes a
 * partial approval and a stop from a lapse, so mapping them would be refused.
 */
export const CONSENT_WIRE_OUTCOME: Record<ConsentOutcome, ConsentContinuationWireOutcome> = {
  granted: "granted",
  partially_granted: "partially_granted",
  denied: "denied",
  expired: "expired",
  revoked: "revoked",
};

/** Outcomes that carry the other person's information into the answer turn. */
export function isSharedOutcome(outcome: string | null | undefined): outcome is "granted" | "partially_granted" {
  return outcome === "granted" || outcome === "partially_granted";
}

/** The exact message a follow-up turn for this outcome sends. */
export function consentContinuationSentLabel(outcome: ConsentOutcome): string {
  return CONSENT_OUTCOME_LABELS[CONSENT_WIRE_OUTCOME[outcome]];
}

/** A sent label read back from history, as the outcome the server recorded. */
export function wireOutcomeForSentLabel(text: string): ConsentContinuationWireOutcome | null {
  for (const [outcome, label] of Object.entries(CONSENT_OUTCOME_LABELS)) {
    if (label === text) return outcome as ConsentContinuationWireOutcome;
  }
  return null;
}

/** Access that was shared and has since ended: its answers are hidden. */
export function isAccessEndedOutcome(outcome: ConsentOutcome | null | undefined): boolean {
  return outcome === "revoked" || outcome === "expired";
}

function joinLabels(labels: readonly string[]): string {
  const clean = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  if (clean.length <= 1) return clean[0] ?? "";
  return `${clean.slice(0, -1).join(", ")} and ${clean.at(-1)}`;
}

/**
 * What the outcome chip says to the person, e.g. "Kushal shared Food
 * preferences". Display only: the turn itself always sends the fixed label.
 */
export function consentOutcomeDisplayText(input: {
  outcome: ConsentOutcome;
  personName?: string | null;
  sharedLabels?: readonly string[];
}): string {
  const name = input.personName?.trim() || "";
  const who = name || "They";
  const what = joinLabels(input.sharedLabels ?? []);
  switch (input.outcome) {
    case "granted":
      return what ? `${who} shared ${what}` : `${who} shared what you asked for`;
    case "partially_granted":
      return what ? `${who} shared ${what} and declined the rest` : `${who} shared part of what you asked for`;
    case "denied":
      return `${who} declined`;
    case "expired":
      return name ? `${name}'s request expired` : "Your request expired";
    case "revoked":
      return what ? `${who} stopped sharing ${what}` : `${who} stopped sharing`;
  }
}

function progressOutcome(bundle: unknown): ConsentOutcome | "pending" | null {
  const progress = (bundle as { progress?: unknown } | null)?.progress;
  if (!progress || typeof progress !== "object") return null;
  const outcome = (progress as { outcome?: unknown }).outcome;
  if (outcome === "pending") return "pending";
  return typeof outcome === "string" && CONSENT_OUTCOMES.has(outcome) ? (outcome as ConsentOutcome) : null;
}

/**
 * The one answer a chat reports, or null while the request is still open.
 * Uses the server's `progress.outcome` when present; otherwise reads item
 * statuses the same way the server's `bundle_outcome` does, with the richer
 * partial and revoked readings layered on top.
 */
export function informationRequestOutcome(
  bundle: Pick<InformationRequestBundle, "items" | "cancelled">,
): ConsentOutcome | null {
  if (bundle.cancelled) return null;
  const fromServer = progressOutcome(bundle);
  if (fromServer === "pending") return null;
  if (fromServer) return fromServer;
  const statuses = bundle.items.map((item) => item.status);
  if (!statuses.length || statuses.includes("pending")) return null;
  if (statuses.includes("granted")) {
    return statuses.every((status) => status === "granted") ? "granted" : "partially_granted";
  }
  if (statuses.includes("denied")) return "denied";
  if (statuses.includes("revoked")) return "revoked";
  if (statuses.includes("expired")) return "expired";
  return null;
}

/** Labels of what is currently shared in this bundle, for display. */
export function sharedItemLabels(bundle: Pick<InformationRequestBundle, "items">): string[] {
  return bundle.items.filter((item) => item.status === "granted").map((item) => item.label);
}
