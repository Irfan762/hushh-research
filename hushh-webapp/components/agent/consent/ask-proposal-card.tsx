"use client";

/**
 * "One picks, you confirm" (contract C4).
 *
 * One has already chosen the best matching information from the question, so
 * the ask is one sentence: "Ask Kushal for Food preferences · 7 days · for
 * dinner planning", with Send and Change. The full catalog appears only
 * behind Change, searched on the server (`searchCatalog`), with human labels.
 *
 * This component never submits by itself: `onSend` is the caller's existing
 * send path, so there is exactly one way a request is created.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Search, Sparkles } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import { REQUEST_DURATION_OPTIONS } from "@/lib/agent/action-directive-summary";
import { proposalDurationLabel, type ScopeProposal } from "@/lib/agent/scope-proposal";
import type { PersonScopeCatalogPage, RequestablePersonScope } from "@/lib/services/person-profile-service";
import { firstName, joinLabels } from "./request-progress";

export type AskProposalDraft = {
  scopes: RequestablePersonScope[];
  purpose: string;
  durationHours: number;
};

export type AskProposalCardProps = {
  personName: string;
  proposal: ScopeProposal;
  /** The current authority check has finished and a request may be sent. */
  ready: boolean;
  sending: boolean;
  error: string | null;
  onSend: (draft: AskProposalDraft) => void;
  searchCatalog: (query: string, page: number, signal: AbortSignal) => Promise<PersonScopeCatalogPage>;
};

const SEARCH_DEBOUNCE_MS = 200;
const MIN_REASON = 8;

function reasonPhrase(reason: string): string {
  return reason.trim().replace(/^for\s+/i, "");
}

function proposedScopes(proposal: ScopeProposal): RequestablePersonScope[] {
  return proposal.proposed.map((item) => ({
    scopeRef: item.scopeRef, label: item.label, description: null,
    domain: null, sensitivity: null, wildcard: false,
  }));
}

/** "Ask Kushal for Food preferences · 7 days · for dinner planning". */
export function askSentence(personName: string, labels: string[], durationHours: number, reason: string): string {
  const parts = [`Ask ${firstName(personName)} for ${joinLabels(labels)}`, proposalDurationLabel(durationHours)];
  const why = reasonPhrase(reason);
  if (why) parts.push(`for ${why}`);
  return parts.join(" · ");
}

function CatalogPicker({ personName, selected, onToggle, searchCatalog }: {
  personName: string;
  selected: RequestablePersonScope[];
  onToggle: (scope: RequestablePersonScope) => void;
  searchCatalog: AskProposalCardProps["searchCatalog"];
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RequestablePersonScope[]>([]);
  const [page, setPage] = useState<{ page: number; nextPage: number | null } | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const controller = useRef<AbortController | null>(null);

  const run = (text: string, pageNumber: number) => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setState("loading");
    searchCatalog(text, pageNumber, next.signal).then((result) => {
      if (next.signal.aborted) return;
      setResults((current) => {
        if (pageNumber === 1) return result.scopes;
        const known = new Set(current.map((scope) => scope.scopeRef));
        return [...current, ...result.scopes.filter((scope) => !known.has(scope.scopeRef))];
      });
      setPage({ page: result.page, nextPage: result.hasMore ? result.nextPage : null });
      setState("idle");
    }).catch(() => {
      if (!next.signal.aborted) setState("error");
    });
  };

  useEffect(() => {
    const timer = window.setTimeout(() => run(query, 1), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
    // `run` is recreated each render; the query is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);
  useEffect(() => () => controller.current?.abort(), []);

  const selectedRefs = new Set(selected.map((scope) => scope.scopeRef));
  return (
    <div className="space-y-2" data-testid="ask-catalog-picker">
      <label className="relative block">
        <span className="sr-only">Search what {firstName(personName)} can share</span>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Search" className="pl-10" maxLength={120} />
      </label>
      <ul aria-label="Information you can ask for" aria-busy={state === "loading"}
        className="max-h-72 divide-y divide-border/50 overflow-y-auto rounded-[var(--app-card-radius-compact)] bg-background/80">
        {results.map((scope) => {
          const on = selectedRefs.has(scope.scopeRef);
          return (
            <li key={scope.scopeRef}>
              <button type="button" aria-pressed={on} onClick={() => onToggle(scope)}
                className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2 text-left transition-colors duration-150 hover:bg-accent/40">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">{scope.label}</span>
                  {scope.description ? <span className="block truncate text-xs text-muted-foreground">{scope.description}</span> : null}
                </span>
                <span aria-hidden="true" className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors duration-150 ${
                  on ? "bg-accent-strong text-white" : "border border-border"}`}>
                  {on ? <Check className="h-3 w-3" /> : null}
                </span>
              </button>
            </li>
          );
        })}
        {state === "idle" && !results.length ? (
          <li className="px-3.5 py-3 text-sm text-muted-foreground">Nothing matches. Try another word.</li>
        ) : null}
      </ul>
      {state === "error" ? <p role="alert" className="text-sm text-muted-foreground">We couldn’t search right now. Please try again.</p> : null}
      {state === "loading" ? <p className="text-xs text-muted-foreground">Searching…</p> : null}
      {page?.nextPage && state !== "loading" ? (
        <MorphyButton type="button" size="sm" variant="none" onClick={() => run(query, page.nextPage!)}>Show more</MorphyButton>
      ) : null}
    </div>
  );
}

export function AskProposalCard({ personName, proposal, ready, sending, error, onSend, searchCatalog }: AskProposalCardProps) {
  const [scopes, setScopes] = useState<RequestablePersonScope[]>(() => proposedScopes(proposal));
  const [durationHours, setDurationHours] = useState(proposal.durationHours);
  const [reason, setReason] = useState(proposal.reasonSuggestion);
  const [changing, setChanging] = useState(false);
  const labels = scopes.map((scope) => scope.label || "Selected information");
  const canSend = ready && !sending && scopes.length > 0 && scopes.length <= 50 && reason.trim().length >= MIN_REASON;
  const why = proposal.proposed.find((item) => item.why)?.why;

  const toggle = (scope: RequestablePersonScope) => setScopes((current) =>
    current.some((entry) => entry.scopeRef === scope.scopeRef)
      ? current.filter((entry) => entry.scopeRef !== scope.scopeRef)
      : [...current, scope]);

  return (
    <section aria-label={`Ask ${firstName(personName)}`} data-testid="ask-proposal-card"
      className="space-y-3 rounded-[24px] bg-[linear-gradient(145deg,var(--app-accent-surface),color-mix(in_srgb,var(--background)_94%,var(--app-accent-soft)))] p-4 shadow-[0_18px_55px_-38px_var(--app-accent-deep)] sm:p-5">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-strong text-white">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold leading-6 tracking-[-0.015em] text-foreground [overflow-wrap:anywhere]" data-testid="ask-sentence">
            {askSentence(personName, labels, durationHours, reason)}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {why ?? `${firstName(personName)} decides what to share, and can stop any time.`}
          </p>
        </div>
      </div>

      {changing ? (
        <div className="space-y-3 rounded-[var(--app-card-radius-compact)] bg-background/72 p-3 backdrop-blur-xl">
          <CatalogPicker personName={personName} selected={scopes} onToggle={toggle} searchCatalog={searchCatalog} />
          <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              For how long
              <select value={durationHours} disabled={sending} data-testid="ask-proposal-duration"
                onChange={(event) => setDurationHours(Number(event.target.value))}
                className="block h-11 w-full cursor-pointer rounded-[var(--app-input-radius)] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] px-3.5 text-sm font-normal text-foreground">
                {REQUEST_DURATION_OPTIONS.map((option) => (
                  <option key={option.hours} value={option.hours}>{proposalDurationLabel(option.hours)}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
              What it is for
              <Input value={reason} disabled={sending} maxLength={500} data-testid="ask-proposal-reason"
                onChange={(event) => setReason(event.target.value)} placeholder="dinner planning" />
            </label>
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!changing && reason.trim().length < MIN_REASON ? (
        <p className="text-xs text-muted-foreground">Add a reason so {firstName(personName)} can decide.</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <MorphyButton type="button" size="sm" disabled={!canSend}
          onClick={() => onSend({ scopes, purpose: reason.trim(), durationHours })}>
          {sending ? "Sending…" : !ready ? "Checking…" : "Send"}
        </MorphyButton>
        <MorphyButton type="button" size="sm" variant="none" disabled={sending}
          onClick={() => setChanging((current) => !current)}>
          {changing ? "Done" : "Change"}
        </MorphyButton>
      </div>
    </section>
  );
}
