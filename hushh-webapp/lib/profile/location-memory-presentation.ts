import {
  buildPkmMemoryCardsFromNode,
  shouldSkipPkmMemoryKey,
  type PkmMemoryCard,
  type PkmPathSegment,
} from "@/lib/pkm/pkm-memory-cards";
import { humanizeMemorySegment, looksLikeOpaqueId } from "@/lib/pkm/humanize-segment";

export type LocationMemoryField = {
  context: string;
  selector: string | null;
  label: string;
  value: string;
  card: PkmMemoryCard;
};
export type LocationMemorySection = {
  key: string;
  title: string;
  kind: "place" | "visit" | "memory";
  fields: LocationMemoryField[];
};
export type LocationMemoryPresentation = {
  sections: LocationMemorySection[];
  incomplete: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function identityCounts(items: unknown[], idKey: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const id = record(item) ? item[idKey] : null;
    if (typeof id === "string" && id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// Opaque navigation metadata only. Never put the record's label, address,
// coordinates or note in a URL. Two independent lanes reduce accidental
// collisions; resolution below also rejects any duplicate selector.
function opaqueKey(value: string): string {
  let left = 2166136261;
  let right = 5381;
  for (let index = 0; index < value.length; index += 1) {
    left = Math.imul(left ^ value.charCodeAt(index), 16777619);
    right = Math.imul(right, 33) ^ value.charCodeAt(index);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

const FIELD_LABELS: Record<string, string> = {
  address: "Address", addressBase: "Street address", latitude: "Latitude",
  longitude: "Longitude", houseOrFlat: "House or flat", buildingColor: "Building",
  landmark: "Landmark", postalCode: "Postal code", savedAt: "Saved",
  visitedAt: "Visited", ratedAt: "Rated", rating: "Rating", note: "Note",
};

/** A read projection only: it never rewrites or normalizes the stored domain. */
export function buildLocationMemoryPresentation(params: {
  data: Record<string, unknown> | null;
  sourceLabel?: string;
  updatedAt?: string | null;
}): LocationMemoryPresentation {
  const sections: LocationMemorySection[] = [];
  let remaining = 20_000;
  let incomplete = false;
  const data = params.data;
  if (!data) return { sections, incomplete };

  const addField = (section: LocationMemorySection, value: unknown, path: PkmPathSegment[], identity: unknown, labels: string[], navigable: boolean) => {
    const [card] = buildPkmMemoryCardsFromNode({
      domain: "location", domainTitle: "Location", value, pathSegments: path,
      sourceLabel: params.sourceLabel || "Saved memory", updatedAt: params.updatedAt ?? null,
    });
    if (!card) return;
    section.fields.push({
      context: section.title,
      card,
      label: labels.join(" · ") || "Detail",
      // Cards keep their canonical path/fingerprint/policy. The read surface
      // uses the full authorized scalar instead of the 180-character preview.
      value: String(value),
      selector: navigable ? opaqueKey(JSON.stringify(identity)) : null,
    });
  };

  const walk = (section: LocationMemorySection, value: unknown, path: PkmPathSegment[], identity: unknown[], labels: string[], depth = 0, navigable = true) => {
    if (--remaining < 0 || depth > 64) { incomplete = true; return; }
    if (value === null || value === undefined) return;
    if (typeof value !== "object") {
      if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
        addField(section, value, path, identity, labels, navigable);
      }
      return;
    }
    if (Array.isArray(value)) {
      const ids = identityCounts(value, "id");
      const placeIds = identityCounts(value, "placeId");
      let containerKey: string | null = null;
      for (const [index, item] of value.entries()) {
        if (remaining <= 0) { incomplete = true; break; }
        const idKey = record(item) && typeof item.id === "string" ? "id"
          : record(item) && typeof item.placeId === "string" ? "placeId" : null;
        const id = idKey && record(item) ? item[idKey] : null;
        const unique = typeof id === "string" && (idKey === "id" ? ids : placeIds).get(id) === 1;
        // Without a unique entity id, bind the link to this exact container.
        // A changed/reordered collection becomes unavailable rather than
        // silently selecting another record with an equal leaf value.
        if (!unique && !containerKey) containerKey = opaqueKey(JSON.stringify(value, (key, child) => key && shouldSkipPkmMemoryKey(key) ? undefined : child));
        const itemIdentity = unique ? [idKey, id] : [index, containerKey];
        const name = record(item) ? [item.label, item.name, item.title].find((entry) => typeof entry === "string" && entry.trim()) : null;
        walk(section, item, [...path, index], [...identity, itemIdentity], [...labels, typeof name === "string" ? name : `Item ${index + 1}`], depth + 1, navigable);
      }
      return;
    }
    if (!record(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (remaining <= 0) { incomplete = true; break; }
      if (shouldSkipPkmMemoryKey(key)) continue;
      const label = FIELD_LABELS[key] || (looksLikeOpaqueId(key) ? "Saved item" : humanizeMemorySegment(key));
      walk(section, child, [...path, key], [...identity, key], [...labels, label], depth + 1, navigable);
    }
  };

  const collection = (branch: string, listKey: string, kind: "place" | "visit", idKey: string) => {
    const envelope = data[branch];
    if (!record(envelope) || !Array.isArray(envelope[listKey])) return false;
    const items = envelope[listKey];
    const ids = identityCounts(items, idKey);
    for (const [index, item] of items.entries()) {
      if (--remaining < 0) { incomplete = true; break; }
      if (!record(item)) {
        const section: LocationMemorySection = { key: `${branch}-${index}`, title: `${humanizeMemorySegment(branch)} · Item ${index + 1}`, kind: "memory", fields: [] };
        walk(section, item, [branch, listKey, index], [branch, listKey, index], ["Detail"], 0, false);
        if (section.fields.length > 0) sections.push(section);
        continue;
      }
      const id = item[idKey];
      const unique = typeof id === "string" && ids.get(id) === 1;
      const title = typeof item.label === "string" && item.label.trim() ? item.label.trim()
        : kind === "place" && typeof item.category === "string" ? humanizeMemorySegment(item.category)
        : kind === "place" ? "Saved place" : "Place visited";
      const section: LocationMemorySection = { key: `${branch}-${index}`, title, kind, fields: [] };
      for (const [key, value] of Object.entries(item)) {
        if (remaining <= 0) { incomplete = true; break; }
        if (shouldSkipPkmMemoryKey(key) || key === "label" || key === "placeId") continue;
        // The composed address is the primary address. An identical street
        // copy and category label need no duplicate rows, but unique parts and
        // unfamiliar future fields remain readable.
        if (key === "addressBase" && typeof value === "string" && typeof item.address === "string" && value.trim() === item.address.trim()) continue;
        if (key === "category" && humanizeMemorySegment(String(value)).toLowerCase() === title.toLowerCase()) continue;
        walk(section, value, [branch, listKey, index, key], [branch, listKey, id, key], key === "addressDetails" ? [] : [FIELD_LABELS[key] || humanizeMemorySegment(key)], 0, unique);
      }
      const fallbackKey = typeof item.label === "string" ? "label" : typeof item.category === "string" ? "category" : null;
      if (section.fields.length === 0 && fallbackKey) {
        addField(section, item[fallbackKey], [branch, listKey, index, fallbackKey], [branch, listKey, id, fallbackKey], [humanizeMemorySegment(fallbackKey)], unique);
      }
      if (section.fields.length > 0) sections.push(section);
    }
    // Preserve extra sibling content on an evolved or legacy envelope.
    const extra = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== listKey && !shouldSkipPkmMemoryKey(key)));
    const section: LocationMemorySection = { key: `${branch}-other`, title: humanizeMemorySegment(branch), kind: "memory", fields: [] };
    walk(section, extra, [branch], [branch], []);
    if (section.fields.length > 0) sections.push(section);
    return true;
  };

  const savedPlaces = collection("saved_places", "locations", "place", "id");
  const visits = collection("visit_notes", "visits", "visit", "placeId");
  for (const [key, value] of Object.entries(data)) {
    if (remaining <= 0) { incomplete = true; break; }
    if (shouldSkipPkmMemoryKey(key) || (key === "saved_places" && savedPlaces) || (key === "visit_notes" && visits)) continue;
    const section: LocationMemorySection = { key, title: key === "agent_memory" ? "Location details" : humanizeMemorySegment(key), kind: "memory", fields: [] };
    walk(section, value, [key], [key], typeof value === "object" ? [] : [section.title]);
    if (section.fields.length > 0) sections.push(section);
  }
  return { sections, incomplete };
}

export function resolveLocationMemoryField(presentation: LocationMemoryPresentation, selector: string | null | undefined): LocationMemoryField | null {
  if (!selector || !/^[a-f0-9]{16}$/.test(selector)) return null;
  const matches = presentation.sections.flatMap((section) => section.fields).filter((field) => field.selector === selector);
  return matches.length === 1 ? matches[0]! : null;
}
