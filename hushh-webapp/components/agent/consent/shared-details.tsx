"use client";

/**
 * What someone shared, as a person would read it: a short list of
 * label and value rows. The decrypted record is a memory tree (entities,
 * kinds, statuses, memory ids); none of that structure is information, so it
 * is never rendered. Values stay in React memory only.
 */
import { useState } from "react";

export type SharedDetailRow = { label: string; values: string[] };

/** Structure and bookkeeping keys: never a label, never a value. */
const META_KEYS = new Set([
  "kind", "status", "id", "type", "state", "created_at", "updated_at", "createdat", "updatedat",
  "observed_at", "observedat", "timestamp", "confidence", "source", "sources", "version",
  "schema", "schema_version", "hash", "revision", "scope", "scope_ref", "scoperef", "domain",
  "sensitivity", "embedding", "vector", "provenance", "tags", "weight", "score", "salience",
  "entity_id", "memory_id", "segment_id", "path", "key", "ref", "uri", "checksum",
]);
/** Keys that only group values; their children keep the parent's label. */
const PASS_THROUGH_KEYS = new Set([
  "entities", "items", "records", "data", "values", "attributes", "observations", "facts",
  "notes", "summary", "description", "value", "text", "content", "details", "entries", "memories",
]);

const HEX_ID = /^[0-9a-f]{8,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Memory ids ("mem_65725402299c"), uuids, hex digests and *_id keys. */
export function isInternalKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  if (META_KEYS.has(k) || /(^|_)id$/.test(k) || /[a-z]Id$/.test(key)) return true;
  if (/^(mem|ent|seg|obs|rec|node|att)[_-]?[0-9a-f]{6,}$/i.test(k)) return true;
  return HEX_ID.test(k) || UUID.test(k) || /\d{6,}/.test(k);
}

function isInternalValue(value: string): boolean {
  const v = value.trim();
  return !v || UUID.test(v) || (HEX_ID.test(v) && v.length >= 12) || ISO_TIME.test(v)
    || /^(mem|ent|seg|obs|rec)[_-][0-9a-f]{6,}$/i.test(v);
}

/** "food_preferences" and "foodPreferences" read as "Food preferences". */
export function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : key;
}

const MAX_ROWS = 40;
const MAX_DEPTH = 8;

export function humanSharedDetails(data: unknown, fallbackLabel: string): SharedDetailRow[] {
  const rows = new Map<string, string[]>();
  const seenValues = new Set<string>();
  const push = (label: string, raw: string) => {
    const value = raw.trim();
    const normalized = value.toLowerCase().replace(/\s+/g, " ");
    if (isInternalValue(value) || seenValues.has(normalized) || rows.size >= MAX_ROWS) return;
    seenValues.add(normalized);
    const list = rows.get(label) ?? [];
    list.push(value);
    rows.set(label, list);
  };
  const walk = (node: unknown, label: string, depth: number) => {
    if (depth > MAX_DEPTH || node === null || node === undefined) return;
    if (typeof node === "string") return push(label, node);
    if (typeof node === "number" && Number.isFinite(node)) return push(label, String(node));
    if (typeof node === "boolean") return push(label, node ? "Yes" : "No");
    if (Array.isArray(node)) {
      node.slice(0, 50).forEach((entry) => walk(entry, label, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const lower = key.trim().toLowerCase();
      if (META_KEYS.has(lower)) continue;
      if (lower === "label" || lower === "title" || lower === "name") {
        // A display name on a record is a value of that record, not a heading.
        if (typeof value === "string") push(label, value);
        continue;
      }
      if (isInternalKey(key) || PASS_THROUGH_KEYS.has(lower)) walk(value, label, depth + 1);
      else walk(value, humanizeKey(key), depth + 1);
    }
  };
  walk(data, fallbackLabel || "Shared", 0);
  return [...rows.entries()].map(([label, values]) => ({ label, values }));
}

const LONG_VALUE = 160;
const VISIBLE_ROWS = 6;

function DetailValue({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const long = value.length > LONG_VALUE;
  return (
    <span className="block">
      <span className={long && !open ? "line-clamp-3" : undefined}>{value}</span>
      {long ? (
        <button type="button" onClick={() => setOpen((current) => !current)}
          className="mt-1 inline-flex min-h-11 cursor-pointer items-center text-xs font-medium text-accent-strong sm:min-h-8">
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </span>
  );
}

/**
 * One row per shared item, headed by the server's human label for it
 * ("Food preferences"). Headings are never derived from the memory tree's own
 * keys on this device: that produced a "Preferences" row beside "Food
 * preferences" for the same item.
 */
export function sharedItemRows(
  values: Array<{ requestId: string; label: string; data: Record<string, unknown> }>,
): Array<SharedDetailRow & { key: string }> {
  return values.flatMap((value) => {
    const label = value.label.trim() || "Shared";
    const rowValues = humanSharedDetails(value.data, label).flatMap((row) => row.values);
    return rowValues.length ? [{ key: value.requestId, label, values: rowValues }] : [];
  });
}

export function SharedDetailsList({ values }: {
  values: Array<{ requestId: string; label: string; data: Record<string, unknown> }>;
}) {
  const [showAll, setShowAll] = useState(false);
  const allRows = sharedItemRows(values);
  const total = allRows.reduce((sum, row) => sum + row.values.length, 0);
  // At most VISIBLE_ROWS values before "Show all", across items in order.
  let budget = VISIBLE_ROWS;
  const rows = showAll ? allRows : allRows.flatMap((row) => {
    if (budget <= 0) return [];
    const shown = row.values.slice(0, budget);
    budget -= shown.length;
    return [{ ...row, values: shown }];
  });
  const visible = rows;
  if (!allRows.length) {
    return <p className="text-sm text-muted-foreground" data-testid="chat-shared-information">Nothing readable was shared yet.</p>;
  }
  return (
    <div data-testid="chat-shared-information" className="rounded-[var(--app-card-radius-compact)] bg-background/80">
      <dl className="divide-y divide-border/50">
        {visible.map((row) => (
          <div key={row.key} className="grid gap-0.5 px-3.5 py-2.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-4">
            <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">{row.label}</dt>
            <dd className="min-w-0 space-y-1 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
              {row.values.map((value, index) => <DetailValue key={index} value={value} />)}
            </dd>
          </div>
        ))}
      </dl>
      {total > VISIBLE_ROWS ? (
        <button type="button" onClick={() => setShowAll((current) => !current)}
          className="flex min-h-11 w-full cursor-pointer items-center justify-center border-t border-border/50 text-xs font-medium text-accent-strong">
          {showAll ? "Show fewer" : `Show all ${total}`}
        </button>
      ) : null}
    </div>
  );
}
