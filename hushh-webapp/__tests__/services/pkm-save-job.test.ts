import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A long explicit memory save runs as a resumable job. Production 2026-09-29: a
 * ~17 KB pasted context transfer lost every section that was still unprepared
 * at the 300 s / 8 min deadlines, and a degraded section was filed as
 * unreadable instead of retried. Every line of the owner's text must end up
 * saved, accounted for with a reason, or shown as "not yet saved" with Retry.
 * All content here is synthetic.
 */

const mocks = vi.hoisted(() => ({ preview: vi.fn(), add: vi.fn() }));

vi.mock("@/lib/agent/agent-pkm-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/agent-pkm-memory")>()),
  previewAgentPkmMemory: mocks.preview,
  addToPKM: mocks.add,
}));

import type { AgentPkmPreviewCard, AgentPkmSaveResult } from "@/lib/agent/agent-pkm-memory";
import { runExplicitPkmSave } from "@/lib/agent/agent-pkm-explicit-save";
import { sha256Hex } from "@/lib/personal-knowledge-model/mutation-plan";
import { computePkmLineCoverage, locatePkmQuote } from "@/lib/pkm/pkm-save-coverage";
import {
  buildPkmSaveJobCoverage,
  buildPkmSaveJobReceipt,
  createPkmSaveJob,
  loadPkmSaveJob,
  persistPkmSaveJob,
  resumeExplicitPkmSaveJob,
  runPkmSaveJob,
  startExplicitPkmSaveJob,
  withPkmSaveJobLock,
  type PkmSaveJob,
  type PkmSaveJobDeps,
} from "@/lib/pkm/pkm-save-job";
import { sourceChunkRange } from "@/lib/pkm/pkm-source-chunks";

const USER = "owner-synthetic";
const VAULT_KEY = "ab".repeat(32);
const MARK = "Synthetic-QZX-7";
const NOT_KNOWN = "# Information not known";
const REPEATED = "- Housing fact 1: synthetic detail 1 for Housing";
const KNOWN = "- Food fact 2: synthetic detail 2 for Food";

const TOPICS = [
  "Identity basics", "Work and role", "Company", "Product", "Core stack", "Infrastructure", "Vendors",
  "People", "Metrics", "Compensation", "Immigration", "Housing", "Health habits", "Food", "Travel",
  "Learning", "Communication style", "Goals", "Projects", "Information not known",
];

/** Founder-shaped: a title, 20 `#` sections, a 25-bullet stack, a disclaimer, a repeat. */
function founderShapedDocument(): string {
  const parts = [`Personal context transfer for One (${MARK})`, ""];
  for (const topic of TOPICS) {
    parts.push(`# ${topic}`);
    if (topic === "Core stack") {
      for (let index = 1; index <= 25; index += 1) parts.push(`- Stack item ${index}: synthetic tool ${index} for layer ${index}`);
    } else if (topic === "Information not known") {
      parts.push("I do not have reliable information for:", "- Exact home street address", "- Passwords or keys", "- Exact salary history");
    } else {
      for (let index = 1; index <= 4; index += 1) parts.push(`- ${topic} fact ${index}: synthetic detail ${index} for ${topic}`);
      if (topic === "Travel") parts.push(REPEATED);
      parts.push(`Background: ${Array.from({ length: 6 }, (_, index) =>
        `The ${topic.toLowerCase()} note ${index + 1} describes a synthetic routine with ordinary words and no identifiers at all.`,
      ).join(" ")}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

const SOURCE = founderShapedDocument();

/** Stand-in for the memory agents: one exact quote per stated fact, at most eight per call. */
function simulatedAgent(message: string) {
  const facts: string[] = [];
  const notMemory: Array<{ quote: string; reason: "duplicate" | "disclaimer" }> = [];
  const heading = /^#\s+(.+)$/m.exec(message)?.[1] ?? "context";
  for (const line of message.split("\n")) {
    if (!line.trim() || /^#{1,6}\s/.test(line)) continue;
    if (heading === "Information not known") notMemory.push({ quote: line, reason: "disclaimer" });
    else if (heading === "Travel" && line === REPEATED) notMemory.push({ quote: line, reason: "duplicate" });
    else if (line.startsWith("Background: ")) facts.push(...(line.match(/[^.]+\./g) ?? []));
    else facts.push(line);
  }
  const domain = heading.toLowerCase().replace(/[^a-z]+/g, "_");
  return {
    agent_id: "agent_memory_segmentation", agent_name: "Memory", model: "stub", used_fallback: false,
    cards: facts.slice(0, 8).map((quote, index): AgentPkmPreviewCard => ({
      card_id: `c${index}`, source_text: quote, write_mode: "can_save", target_domain: domain,
      candidate_payload: { note: quote.replace(/^-\s*/, "").trim() }, structure_decision: { target_domain: domain },
      merge_decision: { merge_mode: "create_entity" }, primary_json_path: `${domain}.note_${index + 1}`,
    })),
    preview_summary: {
      total_segments_detected: facts.length,
      split_recommended: facts.length > 8, has_more_candidates: facts.length > 8, not_memory: notMemory,
    },
  };
}

/** The server: one write per commit id; a second write under the same id is refused. */
function fakeServer() {
  const writes = new Map<string, number>();
  let version = 0;
  const commit = vi.fn(async ({ cards, idempotencyScopes }: { cards: AgentPkmPreviewCard[]; idempotencyScopes?: readonly (string | undefined)[] }) => {
    const results: AgentPkmSaveResult["results"] = cards.map((card, index) => {
      // The one-shot save sends no scope: every call is then a fresh write.
      const scope = idempotencyScopes?.[index] ?? `unscoped_${writes.size}_${card.card_id}`;
      if (writes.has(scope)) {
        return { cardId: card.card_id, domain: "", scope: null, sharingPosture: "", success: false, message: "pkm_commit_id_binding_mismatch" };
      }
      version += 1;
      writes.set(scope, version);
      return {
        cardId: card.card_id, domain: String(card.target_domain), scope: null, sharingPosture: "", success: true, outcome: "saved",
        result: { saveState: "saved", success: true, dataVersion: version, fullBlob: {}, commitId: `commit_${version}` },
      };
    });
    const saved = results.filter((result) => result.success).length;
    return { attempted: cards.length, saved, failed: cards.length - saved, domains: [], results };
  });
  return { writes, commit };
}

function harness(overrides: Partial<PkmSaveJobDeps> = {}) {
  const server = fakeServer();
  const state = { clock: Date.now(), unlocked: true };
  const deps: PkmSaveJobDeps = {
    prepare: vi.fn(async ({ text }: { text: string }) => {
      state.clock += 2_000;
      return simulatedAgent(text);
    }),
    commit: server.commit,
    persist: (job) => persistPkmSaveJob(job, VAULT_KEY),
    isUnlocked: () => state.unlocked,
    findDuplicate: (candidate) => (candidate === KNOWN ? { kind: "exact", domain: "food", path: ["breakfast"] } : null),
    now: () => state.clock,
    sleep: async (ms) => {
      state.clock += ms;
    },
    ...overrides,
  };
  return { server, state, deps };
}

async function newJob(now = Date.now()): Promise<PkmSaveJob> {
  return createPkmSaveJob({ userId: USER, message: SOURCE, currentDomains: [], assistantMessageId: "message-1", now });
}

/** Same schema as the service, so opening it here never leaves a store-less database. */
function openSecureCache(): IDBOpenDBRequest {
  const request = indexedDB.open("hushh-secure-resource-cache", 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("resource_cache", { keyPath: "key" }).createIndex("userId", "userId", { unique: false });
  };
  return request;
}

/** Empty the store in place: the service keeps its connections open, so a delete would block. */
function clearSecureCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = openSecureCache();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("resource_cache")) {
        database.close();
        resolve();
        return;
      }
      const transaction = database.transaction("resource_cache", "readwrite");
      transaction.objectStore("resource_cache").clear();
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

function rawCacheRecords(): Promise<Array<{ key: string }>> {
  return new Promise((resolve, reject) => {
    const request = openSecureCache();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("resource_cache")) {
        database.close();
        resolve([]);
        return;
      }
      const all = database.transaction("resource_cache", "readonly").objectStore("resource_cache").getAll();
      all.onsuccess = () => {
        resolve(all.result as Array<{ key: string }>);
        database.close();
      };
      all.onerror = () => reject(all.error);
    };
  });
}

beforeEach(() => {
  mocks.preview.mockReset();
  mocks.add.mockReset();
});

afterEach(async () => {
  await clearSecureCache();
  localStorage.clear();
  sessionStorage.clear();
});

describe("line coverage", () => {
  it("maps a repeated quote to its own occurrence and needs every word quoted", () => {
    const source = "# Pets\n- Dog: Rex\n- Dog: Rex\n- Cat: Tom and Ivy\n";
    const range = { start: 0, end: source.length };
    const first = locatePkmQuote({ source, range, quote: "Dog: Rex", cursor: 0 })!;
    const second = locatePkmQuote({ source, range, quote: "Dog: Rex", cursor: first.end })!;
    expect(second.start).toBeGreaterThan(first.start);
    const coverage = computePkmLineCoverage({
      source,
      spans: [
        { ...first, kind: "committed", cardId: "a" },
        { ...second, kind: "not_memory", reason: "duplicate" },
        // Negative control: "and Ivy" is never quoted, so the line is not saved.
        { ...locatePkmQuote({ source, range, quote: "Cat: Tom" })!, kind: "committed", cardId: "b" },
      ],
      destinations: new Map([["a", { cardId: "a", domain: "pets", path: "pets.dog", commitId: "commit_1" }]]),
    });
    expect(coverage.lines.map((line) => line.status)).toEqual(["structure", "saved", "not_memory", "not_yet_saved"]);
    expect(coverage.lines[1]!.destinations).toEqual([{ cardId: "a", domain: "pets", path: "pets.dog", commitId: "commit_1" }]);
    expect(coverage.accounted).toBe(3);
  });
});

describe("resumable explicit save job", () => {
  it("accounts for every line of a founder-shaped document", async () => {
    expect(SOURCE.length).toBeGreaterThan(15_000);
    expect(SOURCE.length).toBeLessThan(19_000);
    const { deps, server } = harness();
    const job = await newJob();
    const outcome = await runPkmSaveJob(job, deps);
    expect(outcome.paused).toBeNull();
    expect(job.state).toBe("completed");

    const { coverage } = buildPkmSaveJobCoverage(job);
    expect(coverage.totals.not_yet_saved).toBe(0);
    expect(coverage.totals.held).toBe(0);
    expect(coverage.accounted).toBe(coverage.totals.lines);
    expect(coverage.totals).toEqual({ lines: 141, saved: 115, not_memory: 6, structure: 20, held: 0, not_yet_saved: 0 });
    // The 25-bullet stack was split past the eight-fact cap, and every bullet landed.
    const stackLines = coverage.lines.filter((line) => SOURCE.slice(line.start, line.end).startsWith("- Stack item"));
    expect(stackLines).toHaveLength(25);
    expect(stackLines.every((line) => line.status === "saved" && line.destinations[0]?.commitId)).toBe(true);
    const reasonOf = (text: string) =>
      coverage.lines.find((line) => SOURCE.slice(line.start, line.end).trimEnd() === text)?.reason;
    expect(reasonOf("- Passwords or keys")).toBe("disclaimer");
    expect(reasonOf(KNOWN)).toBe("already_known");
    expect(reasonOf(NOT_KNOWN)).toBe("heading");

    const { receipt } = buildPkmSaveJobReceipt(job);
    expect(receipt.saved).toBe(server.writes.size);
    expect(receipt.coverage).toMatchObject({ totalLines: 141, accountedLines: 141, notYetSavedLines: 0, jobState: "completed" });
    expect(receipt.unprepared).toBe(0);
    // Completed jobs leave nothing behind in the encrypted cache.
    expect(await loadPkmSaveJob(USER, job.id, VAULT_KEY)).toBeNull();
  });

  it("turns a timeout and a degraded answer into retries, and a deadline into a pause", async () => {
    // Negative control, the one-shot save: a section still unprepared at the
    // preparation budget, and a degraded one, are reported and never saved.
    const hang = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
    });
    mocks.preview.mockImplementation(async ({ message, signal }: { message: string; signal?: AbortSignal }) => {
      if (message.startsWith("# Core stack")) return hang(signal);
      const answer = simulatedAgent(message);
      return message.startsWith("# Vendors") ? { ...answer, used_fallback: true } : answer;
    });
    mocks.add.mockImplementation(fakeServer().commit);
    const oneShot = await runExplicitPkmSave({
      userId: USER, message: SOURCE, currentDomains: [], vaultKey: VAULT_KEY, vaultOwnerToken: "token", preparationBudgetMs: 400,
    });
    expect(oneShot.receipt.unprepared).toBeGreaterThan(0);

    let stackAttempts = 0;
    let vendorAttempts = 0;
    const { deps, state } = harness({
      prepareTimeoutMs: 25,
      prepare: vi.fn(async ({ text, signal }: { text: string; signal: AbortSignal }) => {
        state.clock += 2_000;
        if (text.startsWith("# Core stack") && (stackAttempts += 1) === 1) return hang(signal);
        if (text.startsWith("# Vendors") && (vendorAttempts += 1) === 1) return { ...simulatedAgent(text), used_fallback: true };
        return simulatedAgent(text);
      }),
    });
    const job = await newJob(state.clock);
    const first = await runPkmSaveJob(job, deps, { pauseAt: state.clock + 20_000 });
    expect(first.paused).toBe("deadline");
    const paused = buildPkmSaveJobReceipt(job).receipt.coverage!;
    expect(paused.notYetSavedLines).toBeGreaterThan(0);

    // A reload: a fresh runner continues from the encrypted record.
    const reloaded = (await loadPkmSaveJob(USER, job.id, VAULT_KEY))!;
    expect(reloaded.steps.some((step) => step.state === "committed")).toBe(true);
    const second = await runPkmSaveJob(reloaded, deps);
    expect(second.paused).toBeNull();
    expect(reloaded.state).toBe("completed");
    expect(stackAttempts).toBeGreaterThan(1);
    // The degraded section was asked again (then split), never filed as unreadable.
    expect(vendorAttempts).toBeGreaterThan(1);
    const { coverage } = buildPkmSaveJobCoverage(reloaded);
    expect(coverage.accounted).toBe(coverage.totals.lines);
    expect(coverage.lines.filter((line) => SOURCE.slice(line.start, line.end).startsWith("- Vendors fact"))
      .every((line) => line.status === "saved")).toBe(true);
    expect(buildPkmSaveJobReceipt(reloaded).receipt.unreadable).toBe(0);
  });

  it("pauses on a relock mid-job and finishes after unlock without a second write", async () => {
    // Negative control, the one-shot save: a relock during writing loses them.
    mocks.preview.mockImplementation(async ({ message }: { message: string }) => simulatedAgent(message));
    mocks.add.mockImplementation(async ({ cards }: { cards: AgentPkmPreviewCard[] }) => ({
      attempted: cards.length, saved: 0, failed: cards.length, domains: [],
      results: cards.map((card) => ({ cardId: card.card_id, domain: "", scope: null, sharingPosture: "", success: false })),
    }));
    const oneShot = await runExplicitPkmSave({ userId: USER, message: SOURCE, currentDomains: [], vaultKey: VAULT_KEY, vaultOwnerToken: "token" });
    expect(oneShot.receipt.saved).toBe(0);
    expect(oneShot.receipt.failed).toBeGreaterThan(0);

    const { deps, server, state } = harness();
    let commits = 0;
    deps.commit = vi.fn(async (params) => {
      if ((commits += 1) === 3) {
        // The vault locked mid-write: the coordinator's guard refuses every card.
        state.unlocked = false;
        return { attempted: params.cards.length, saved: 0, failed: params.cards.length, domains: [],
          results: params.cards.map((card) => ({ cardId: card.card_id, domain: "", scope: null, sharingPosture: "", success: false })) };
      }
      return server.commit(params);
    });
    const job = await newJob(state.clock);
    const first = await runPkmSaveJob(job, deps);
    expect(first.paused).toBe("locked");
    const stored = (await loadPkmSaveJob(USER, job.id, VAULT_KEY))!;
    expect(stored.state).toBe("paused_locked");
    expect(stored.steps.filter((step) => step.state === "prepared")).toHaveLength(1);
    expect(buildPkmSaveJobReceipt(stored).receipt.coverage!.notYetSavedLines).toBeGreaterThan(0);

    state.unlocked = true;
    const resumed = await runPkmSaveJob(stored, deps);
    expect(resumed.paused).toBeNull();
    expect(stored.state).toBe("completed");
    const { coverage } = buildPkmSaveJobCoverage(stored);
    expect(coverage.accounted).toBe(coverage.totals.lines);
    expect(buildPkmSaveJobReceipt(stored).receipt.saved).toBe(server.writes.size);
  });

  it("never writes a replayed step twice and never counts an unconfirmed write", async () => {
    const { deps, server, state } = harness();
    let dropped = false;
    deps.commit = vi.fn(async (params) => {
      const result = await server.commit(params);
      // The first write lands on the server, then the connection drops.
      if (!dropped) {
        dropped = true;
        throw new TypeError("network dropped after commit");
      }
      return result;
    });
    const job = await newJob(state.clock);
    await runPkmSaveJob(job, deps);
    const firstScopes = (deps.commit as ReturnType<typeof vi.fn>).mock.calls[0]![0].idempotencyScopes as string[];
    const replays = (deps.commit as ReturnType<typeof vi.fn>).mock.calls
      .map(([params]) => params.idempotencyScopes as string[])
      .filter((scopes) => scopes[0] === firstScopes[0]);
    expect(replays.length).toBeGreaterThan(1);
    expect(replays.every((scopes) => JSON.stringify(scopes) === JSON.stringify(firstScopes))).toBe(true);
    // The scope is sha256(jobId, span) plus the card's place in the step.
    const replayedStep = job.steps.find((step) => firstScopes[0]!.startsWith(`${step.id}:`))!;
    const range = sourceChunkRange(replayedStep.chunk);
    expect(replayedStep.id).toBe(await sha256Hex(`${job.id}:${range.start}:${range.end}`));
    // One write per scope on the server, and the receipt counts only acknowledged commits.
    const { receipt } = buildPkmSaveJobReceipt(job);
    expect(receipt.saved).toBe(server.writes.size - firstScopes.length);
    expect(receipt.coverage!.notYetSavedLines).toBeGreaterThan(0);
    expect(job.state).toBe("completed_with_gaps");

    // Re-running a finished job, or racing a second runner, does nothing new.
    const calls = (deps.commit as ReturnType<typeof vi.fn>).mock.calls.length;
    await runPkmSaveJob(job, deps);
    expect((deps.commit as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    let release!: () => void;
    const holder = withPkmSaveJobLock(job.id, () => new Promise<string>((resolve) => {
      release = () => resolve("first");
    }));
    expect(await withPkmSaveJobLock(job.id, async () => "second")).toBeNull();
    release();
    expect(await holder).toBe("first");
  });

  it("keeps the job only in the vault-encrypted cache, never in web storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    mocks.preview.mockImplementation(async ({ message }: { message: string }) => simulatedAgent(message));
    const server = fakeServer();
    mocks.add.mockImplementation(server.commit);
    const started = await startExplicitPkmSaveJob({
      userId: USER, message: SOURCE, currentDomains: [], vaultKey: VAULT_KEY, vaultOwnerToken: "token",
      assistantMessageId: "message-1", pauseAt: Date.now() - 1,
    });
    expect(started.paused).toBe("deadline");

    const records = await rawCacheRecords();
    expect(records.length).toBe(2);
    expect(records.every((record) => record.key.startsWith(`${USER}:pkm_save_job:v1:`))).toBe(true);
    expect(JSON.stringify(records)).not.toContain(MARK);
    // Control: the decrypted job does hold the owner's text.
    expect(JSON.stringify(await loadPkmSaveJob(USER, started.jobId, VAULT_KEY))).toContain(MARK);

    const finished = (await resumeExplicitPkmSaveJob({
      userId: USER, jobId: started.jobId, vaultKey: VAULT_KEY, vaultOwnerToken: "token",
    }))!;
    expect(finished.jobState).toBe("completed");
    expect(finished.receipt.coverage!.accountedLines).toBe(finished.receipt.coverage!.totalLines);
    const createdAt = new Date(JSON.parse(JSON.stringify(mocks.add.mock.calls[0]![0])).confirmation.confirmedAt).getTime();
    expect(mocks.add.mock.calls.every(([params]) => params.idempotencyScopes.length === params.cards.length &&
      new Date(params.confirmation.confirmedAt).getTime() === createdAt)).toBe(true);

    expect(await rawCacheRecords()).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });
});
