/**
 * Offline self-evolution (paper Section 3.3).
 *
 * Step 1: diagnostic rollout — completed tasks with verdicts are the batch.
 * Step 2: feedback-driven mutation — an LLM refiner contrasts successful and
 *   failed trajectories and proposes a structured edit set (add/delete/revise).
 * Step 3: validation gating — edits must apply cleanly (structural validity);
 *   a configured validationCommand acts as the held-out score proxy. Without
 *   it, candidates are staged for user review.
 * Step 4: rejection memory — rejected candidates are retained as negative
 *   evidence so the refiner does not repeat them.
 */
import { exec } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { EvolutionConfig, PGConfig } from "./config";
import {
  applyEdits,
  formatGraph,
  truncateEnd,
  type Edit,
  type PGStore,
  type TaskRecord,
} from "./graph";
import { formatSteps } from "./tracker";

const REFINER_SYSTEM_PROMPT = `You are the refiner of a Procedural Graph for an LLM coding agent. A Procedural Graph stores procedural knowledge as directed, attributed triplets: source --relation--> target, where edges carry attributes condition (when the transition applies), guidance (how to proceed), and pitfalls (what to avoid). Nodes abstract tool calls (id "tool:<name>"), reasoning steps (id "step:<name>"), and task states (id "state:<name>").

Your job: inspect successful and failed task trajectories, identify repeated error loops in failures and reusable multi-step shortcuts in successes, then propose a small set of high-value edits.

Respond with ONLY a JSON array. No prose, no markdown fences. Valid operations:
{"op":"add_node","id":"step:NAME","kind":"step|tool|state","label":"...","description":"..."}
{"op":"add_edge","source":"...","relation":"leads_to|requires|after|if_failed|before","target":"...","attrs":{"condition":"...","guidance":"...","pitfalls":"..."}}
{"op":"delete_node","id":"..."}
{"op":"delete_edge","source":"...","relation":"...","target":"..."}
{"op":"revise_edge","source":"...","relation":"...","target":"...","attrs":{"condition":"...","guidance":"...","pitfalls":"..."}}

Rules:
- Use existing node ids verbatim when the trajectory already contains that tool. For new tool nodes, id must be "tool:" + the exact tool name.
- Add an edge only when the transition is genuinely reusable: it appears in successes, or adding it fixes a repeated failure.
- Write concrete, project-specific condition/guidance/pitfalls. Be specific, not generic.
- Never propose deleting the Start node.
- Do not repeat edits you see in the rejection memory.
- Prefer few, high-value edits over many weak ones. Empty array [] is acceptable.`;

function formatTaskForRefiner(t: TaskRecord): string {
  const verdict = t.score !== undefined ? `${t.verdict} (score ${t.score})` : t.verdict;
  return [
    `Task: ${t.query}`,
    `Verdict: ${verdict}`,
    formatSteps(t.steps),
  ].join("\n");
}

function buildRefinerUserPrompt(store: PGStore, batch: TaskRecord[], maxTrajectoryTokens: number): string {
  const successes = batch.filter((t) => t.verdict === "success");
  const failures = batch.filter((t) => t.verdict === "fail");
  const maxChars = maxTrajectoryTokens * 4;

  const parts: string[] = [];
  parts.push("CURRENT PROCEDURAL GRAPH");
  parts.push(formatGraph(store.graph, 300));
  parts.push("");
  parts.push(`SUCCESSFUL TRAJECTORIES (${successes.length})`);
  if (successes.length === 0) parts.push("(none)");
  for (const t of successes) {
    parts.push("```");
    parts.push(formatTaskForRefiner(t));
    parts.push("```");
  }
  parts.push("");
  parts.push(`FAILED TRAJECTORIES (${failures.length})`);
  if (failures.length === 0) parts.push("(none)");
  for (const t of failures) {
    parts.push("```");
    parts.push(formatTaskForRefiner(t));
    parts.push("```");
  }
  parts.push("");
  parts.push("REJECTION MEMORY (previous proposals that failed validation; do not repeat these)");
  if (store.rejectionMemory.length === 0) parts.push("(none)");
  for (const r of store.rejectionMemory.slice(-5)) {
    const edits = r.edits.map((e) => JSON.stringify(e)).join("\n");
    parts.push(`- rejected ${new Date(r.ts).toISOString()} (${r.successes} successes / ${r.failures} failures):\n${edits}`);
  }
  parts.push("");
  parts.push("Propose a JSON array of edits now.");

  // Keep the END of the prompt (paper keeps the final L tokens in order).
  return truncateEnd(parts.join("\n\n"), maxChars);
}

export function parseEdits(text: string): Edit[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  const slice = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const edits: Edit[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const op = (item as { op?: unknown }).op;
    if (
      op === "add_node" ||
      op === "add_edge" ||
      op === "delete_node" ||
      op === "delete_edge" ||
      op === "revise_edge"
    ) {
      edits.push(item as Edit);
    }
  }
  return edits;
}

export async function runValidationCommand(
  command: string,
  candidatePath: string,
  currentGraphPath: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    exec(
      command,
      {
        cwd,
        timeout: 120_000,
        env: {
          ...process.env,
          PG_CANDIDATE_FILE: candidatePath,
          PG_GRAPH_FILE: currentGraphPath,
        },
      },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();
        resolvePromise({ ok: !error, output });
      },
    );
  });
}

interface EvolveDeps {
  store: PGStore;
  config: PGConfig;
  ctx: ExtensionContext;
  graphFilePath: string;
}

/**
 * Run one evolution round: select a verdict-bearing batch, ask the refiner for
 * edits, structurally validate, then stage (or auto-commit). Returns true if a
 * proposal was produced.
 */
export async function maybeEvolve(deps: EvolveDeps, force = false): Promise<boolean> {
  const { store, config, ctx } = deps;
  const evo = config.evolution;

  if (store.staged) {
    ctx.ui.notify("PG: staged proposal pending — run /pg review first", "warning");
    return false;
  }

  const candidates = store.history.filter((t) => !t.evolved && (t.verdict === "success" || t.verdict === "fail"));
  const batch = candidates.slice(0, evo.batchSize);
  if (batch.length === 0) {
    if (force) ctx.ui.notify("PG: no un-evolved tasks with a verdict (use /pg verdict)", "info");
    return false;
  }
  if (!force && batch.length < evo.batchSize) return false;

  if (!ctx.model) {
    ctx.ui.notify("PG: no model available for the refiner", "error");
    return false;
  }

  ctx.ui.notify(`PG: evolving with ${batch.length} tasks (${batch.filter((t) => t.verdict === "success").length} ok / ${batch.filter((t) => t.verdict === "fail").length} fail)…`, "info");

  const userPrompt = buildRefinerUserPrompt(store, batch, evo.maxTrajectoryTokens);
  let raw: string;
  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt: REFINER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
      },
      {
        maxTokens: evo.refinerMaxTokens,
        signal: ctx.signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
      },
    );
    raw = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  } catch (error) {
    console.error("[procedural-graphs] refiner call failed:", error);
    ctx.ui.notify("PG: refiner call failed; no proposal", "error");
    return false;
  }

  const edits = parseEdits(raw);
  if (edits.length === 0) {
    // Mark the batch as processed so it does not retrigger; a no-op is a valid
    // refiner outcome.
    for (const t of batch) t.evolved = true;
    store.stats.evolutions++;
    ctx.ui.notify("PG: refiner proposed no edits; batch marked processed", "info");
    return false;
  }

  const applied = applyEdits(store.graph, edits);
  if (!applied.ok) {
    ctx.ui.notify(`PG: candidate rejected — invalid structure (${applied.errors.length} issues)`, "warning");
    // Treat invalid proposals like rejections so the refiner learns from them.
    store.rejectionMemory.push({
      ts: Date.now(),
      reason: `structurally invalid: ${applied.errors.slice(0, 3).join("; ")}`,
      edits,
      graphSummary: { nodes: store.graph.nodes.length, edges: store.graph.edges.length },
      successes: batch.filter((t) => t.verdict === "success").length,
      failures: batch.filter((t) => t.verdict === "fail").length,
    });
    trimRejectionMemory(store, evo);
    for (const t of batch) t.evolved = true;
    store.stats.rejections++;
    return false;
  }

  store.staged = {
    ts: Date.now(),
    edits,
    candidate: applied.graph,
    taskIds: batch.map((t) => t.id),
  };

  // Validation gate: when a command is configured, run it before deciding.
  if (evo.validationCommand) {
    const candidatePath = deps.graphFilePath.replace(/\.json$/, ".candidate.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(candidatePath, JSON.stringify(applied.graph, null, 2), "utf8");
    const result = await runValidationCommand(evo.validationCommand, candidatePath, deps.graphFilePath, ctx.cwd);
    if (result.ok) {
      commitStaged(deps, "validation passed");
      ctx.ui.notify(`PG: candidate auto-committed (validation passed)\n${result.output.slice(0, 200)}`, "info");
      return true;
    }
    // Validation failed → rejection memory (paper Step 4).
    store.rejectionMemory.push({
      ts: Date.now(),
      reason: `validation failed:\n${result.output.slice(0, 300)}`,
      edits,
      graphSummary: { nodes: applied.graph.nodes.length, edges: applied.graph.edges.length },
      successes: batch.filter((t) => t.verdict === "success").length,
      failures: batch.filter((t) => t.verdict === "fail").length,
    });
    trimRejectionMemory(store, evo);
    store.staged = null;
    for (const t of batch) t.evolved = true;
    store.stats.rejections++;
    ctx.ui.notify("PG: candidate rejected by validation command (see rejection memory)", "warning");
    return false;
  }

  if (evo.autoApprove) {
    commitStaged(deps, "auto-approved");
    ctx.ui.notify(`PG: candidate auto-committed (${edits.length} edits)`, "info");
    return true;
  }

  ctx.ui.notify(`PG: ${edits.length} proposed edits staged — run /pg review`, "info");
  return true;
}

/** Commit the staged candidate and mark its tasks as evolved. */
export function commitStaged(deps: EvolveDeps, note?: string): boolean {
  const { store } = deps;
  if (!store.staged) return false;
  store.graph = store.staged.candidate;
  const ids = new Set(store.staged.taskIds);
  for (const t of store.history) if (ids.has(t.id)) t.evolved = true;
  store.stats.commits++;
  store.stats.evolutions++;
  store.staged = null;
  void note;
  return true;
}

/** Reject the staged candidate into rejection memory (paper Step 4). */
export function rejectStaged(deps: EvolveDeps, reason?: string): boolean {
  const { store, config } = deps;
  if (!store.staged) return false;
  const staged = store.staged;
  const batch = store.history.filter((t) => staged.taskIds.includes(t.id));
  store.rejectionMemory.push({
    ts: Date.now(),
    reason: reason || "rejected by user",
    edits: staged.edits,
    graphSummary: { nodes: staged.candidate.nodes.length, edges: staged.candidate.edges.length },
    successes: batch.filter((t) => t.verdict === "success").length,
    failures: batch.filter((t) => t.verdict === "fail").length,
  });
  trimRejectionMemory(store, config.evolution);
  for (const t of batch) t.evolved = true;
  store.stats.rejections++;
  store.staged = null;
  return true;
}

function trimRejectionMemory(store: PGStore, evo: EvolutionConfig): void {
  if (store.rejectionMemory.length > evo.maxRejectionMemories) {
    store.rejectionMemory = store.rejectionMemory.slice(-evo.maxRejectionMemories);
  }
}