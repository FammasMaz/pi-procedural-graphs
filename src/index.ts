/**
 * pi-procedural-graphs — a pi extension implementing the Procedural Graph
 * framework (arXiv:2609.09153).
 *
 * Online: before every LLM call the localized h-hop subgraph (or full graph on
 * a localization miss) is injected as step-level guidance, biasing the next
 * action without dictating it. Offline: after a batch of verdict-bearing tasks
 * an LLM refiner proposes graph edits; candidates pass structural validation
 * and a configurable validation gate, and rejected ones go to rejection memory.
 *
 * Fully self-contained on disk (.pi/procedural-graph.json): it does not depend
 * on magic-context or any other extension.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
import { DEFAULT_CONFIG, loadConfig, type PGConfig } from "./config";
import { registerCommands, type PGRuntime } from "./commands";
import {
  createSkeletonGraph,
  createEmptyStore,
  loadStore,
  localize,
  neighborhood,
  resolveStorePath,
  saveStore,
  summarizeArgs,
  summarizeResult,
  type PGStore,
} from "./graph";
import { injectGuidance } from "./guidance";
import { maybeEvolve } from "./evolution";
import { Tracker } from "./tracker";

export default function (pi: ExtensionAPI): void {
  let config: PGConfig = structuredClone(DEFAULT_CONFIG);
  let store: PGStore | null = null;
  let cwd = process.cwd();
  let graphFilePath = "";
  const tracker = new Tracker();
  let turnPending = true;

  const runtime: PGRuntime = {
    getConfig: () => config,
    getStore: () => store,
    getTracker: () => tracker,
    getGraphFilePath: () => graphFilePath,
    save: () => {
      if (store && graphFilePath) saveStore(graphFilePath, store);
    },
    saveConfig: () => {
      const path = `${cwd}/.pi/procedural-graph.config.json`;
      writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
    },
    refreshConfig: () => {
      config = loadConfig(cwd);
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    config = loadConfig(cwd);
    graphFilePath = resolveStorePath(cwd, config.graphFile);
    store = loadStore(graphFilePath);
    tracker.reset();
    turnPending = true;
    if (!store && config.enabled) {
      // Lazy init: first session creates the skeleton graph. The user can
      // replace it with /pg init --expert <path> at any time.
      store = createEmptyStore(createSkeletonGraph());
      saveStore(graphFilePath, store);
    }
    if (config.enabled && store) {
      ctx.ui.setStatus("pg", `PG ${store.graph.nodes.length}N/${store.graph.edges.length}E`);
    } else {
      ctx.ui.setStatus("pg", undefined);
    }
  });

  // Task boundaries: each user prompt starts a new task (paper: q, T_t).
  pi.on("before_agent_start", async (event) => {
    tracker.startTask(event.prompt);
  });

  pi.on("turn_start", async () => {
    turnPending = true;
  });

  pi.on("tool_execution_start", async (event) => {
    tracker.recordAction(event.toolName, summarizeArgs(event.args));
  });

  pi.on("tool_execution_end", async (event) => {
    tracker.recordObservation(event.toolName, !event.isError, summarizeResult(event.result));
  });

  // Task end: derive a verdict when configured, then maybe evolve.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!store) return;
    const task = tracker.endTask();
    if (!task || task.steps.length === 0) return;

    let verdict: "success" | "fail" | null = null;
    let score: number | undefined;
    if (config.verdict.command) {
      verdict = await runVerdictCommand(config.verdict.command, ctx.cwd);
    } else if (config.verdict.autoFailOnError && task.steps.some((s) => s.ok === false)) {
      verdict = "fail";
    }

    if (verdict) {
      store.history.push({
        ...task,
        verdict,
        score,
        evolved: false,
      });
      // Cap history so the file stays small.
      if (store.history.length > 200) store.history = store.history.slice(-200);
      saveStore(graphFilePath, store);
      ctx.ui.setStatus("pg", `PG ${store.graph.nodes.length}N/${store.graph.edges.length}E`);
      await maybeEvolve({ store, config, ctx, graphFilePath });
      saveStore(graphFilePath, store);
    }
  });

  // The core: inject step-level guidance before each LLM call.
  pi.on("context", async (event, ctx) => {
    if (!config.enabled || !store || !turnPending) return;
    turnPending = false;
    const result = await injectGuidance(event.messages, store, tracker, config, ctx);
    if (result) return { messages: result.messages };
  });

  pi.on("session_shutdown", async () => {
    if (store && graphFilePath) saveStore(graphFilePath, store);
  });

  registerCommands(pi, runtime);

  // A self-inspection tool so the solver can ask what procedural context is active.
  pi.registerTool({
    name: "pg_status",
    label: "Procedural Graph status",
    description:
      "Return the current Procedural Graph localization (active procedure, reachable transitions, recent steps, stats). Useful to inspect what step-level guidance is available before acting.",
    promptSnippet: "Inspect procedural-graph guidance when uncertain about the next step",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!store) {
        return { content: [{ type: "text", text: "Procedural graph not initialized." }], details: {} };
      }
      const action = tracker.lastToolName;
      const active = action ? localize(store.graph, action) : "Start";
      const hood = active ? neighborhood(store.graph, active, config.guidance.hops) : { nodeIds: new Set<string>(), edges: store.graph.edges };
      const lines = [
        `Graph "${store.graph.name}": ${store.graph.nodes.length} nodes, ${store.graph.edges.length} edges`,
        `Active: ${active}`,
        "",
        hood.edges.length > 0 ? formatNeighborhoodText(store, active, hood) : "No transitions recorded from this procedure yet.",
        "",
        `Stats: ${store.stats.injections} injections (${store.stats.matches} matched / ${store.stats.misses} missed), ${store.stats.evolutions} evolutions (${store.stats.commits} commits / ${store.stats.rejections} rejections)`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });
}

function formatNeighborhoodText(
  store: PGStore,
  active: string | null,
  hood: { nodeIds: Set<string>; edges: PGStore["graph"]["edges"] },
): string {
  const lines: string[] = [`Active procedure: ${active ?? "unknown"}`, "Admissible transitions reachable from here:"];
  const seen = new Set<string>();
  for (const e of hood.edges) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    lines.push(`- ${e.source} --${e.relation}--> ${e.target}`);
    if (e.attrs.condition) lines.push(`    condition: ${e.attrs.condition}`);
    if (e.attrs.guidance) lines.push(`    guidance: ${e.attrs.guidance}`);
    if (e.attrs.pitfalls) lines.push(`    pitfalls: ${e.attrs.pitfalls}`);
  }
  return lines.join("\n");
}

function runVerdictCommand(command: string, cwd: string): Promise<"success" | "fail" | null> {
  return new Promise((resolvePromise) => {
    exec(command, { cwd, timeout: 30_000 }, (error) => {
      // Non-zero exit and "Command failed" (spawn errors like ENOENT) both fail;
      // but timeout/interrupt are treated as null (unknown).
      if (error && typeof (error as { code?: unknown }).code === "string") {
        resolvePromise(null);
        return;
      }
      resolvePromise(error ? "fail" : "success");
    });
  });
}