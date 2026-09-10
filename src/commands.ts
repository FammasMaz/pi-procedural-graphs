/**
 * /pg command surface. One command, many subcommands, so autocompletion and
 * help stay in one place.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import type { PGConfig } from "./config";
import {
  applyEdits,
  createEmptyGraph,
  createSkeletonGraph,
  createEmptyStore,
  formatGraph,
  formatNeighborhood,
  localize,
  neighborhood,
  resolveStorePath,
  validateGraph,
  type Edit,
  type PGStore,
} from "./graph";
import { commitStaged, maybeEvolve, rejectStaged, runValidationCommand } from "./evolution";
import type { Tracker } from "./tracker";

export interface PGRuntime {
  getConfig(): PGConfig;
  getStore(): PGStore | null;
  getTracker(): Tracker;
  getGraphFilePath(): string;
  save(): void;
  saveConfig(): void;
  refreshConfig(): void;
}

const VALUE_FLAGS = new Set([
  "name",
  "expert",
  "kind",
  "label",
  "desc",
  "description",
  "condition",
  "guidance",
  "pitfalls",
  "verdict",
  "note",
  "path",
  "reason",
]);

export function parseArgs(input: string): { positionals: string[]; flags: Map<string, string>; booleans: Set<string> } {
  const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      if (VALUE_FLAGS.has(key) && i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        flags.set(key, unquote(tokens[++i]));
      } else {
        booleans.add(key);
      }
    } else {
      positionals.push(unquote(t));
    }
  }
  return { positionals, flags, booleans };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function registerCommands(pi: ExtensionAPI, rt: PGRuntime): void {
  pi.registerCommand("pg", {
    description: "Procedural Graph: status, init, graph, verdict, evolve, review, accept, reject, edit, export",
    getArgumentCompletions: (prefix: string) => {
      const subs = [
        "status",
        "init",
        "graph",
        "task",
        "verdict",
        "evolve",
        "review",
        "accept",
        "reject",
        "edit",
        "disable",
        "enable",
        "export",
        "reset",
      ];
      const items = subs.map((s) => ({ value: s, label: s }));
      const filtered = prefix ? items.filter((i) => i.value.startsWith(prefix.trim())) : items;
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const { positionals, flags, booleans } = parseArgs(args ?? "");
      const sub = (positionals[0] ?? "status").toLowerCase();
      const rest = positionals.slice(1);
      const store = rt.getStore();
      const config = rt.getConfig();

      if (!store) {
        ctx.ui.notify("PG: no graph store loaded. Run /pg init", "warning");
        return;
      }

      switch (sub) {
        case "status": {
          const s = store.stats;
          const active = rt.getTracker().lastToolName ? localize(store.graph, rt.getTracker().lastToolName) : "Start";
          const pending = store.history.filter((t) => !t.evolved && (t.verdict === "success" || t.verdict === "fail")).length;
          const line = [
            `"${store.graph.name}" ${store.graph.nodes.length}N/${store.graph.edges.length}E`,
            `mode:${config.guidance.mode} h=${config.guidance.hops} w=${config.guidance.window}`,
            `active:${active ?? "unmatched"}`,
            `inject:${s.injections} (${s.matches}✓/${s.misses}✗)`,
            `evolve:${s.evolutions} (${s.commits}✓/${s.rejections}✗)`,
            `history:${store.history.length} (${pending} pending)`,
            `rejection:${store.rejectionMemory.length}`,
            `staged:${store.staged ? "yes → /pg review" : "none"}`,
          ].join(" · ");
          ctx.ui.notify(`PG ${line}`, "info");
          break;
        }

        case "init": {
          if (store.history.length > 0 && !booleans.has("force")) {
            ctx.ui.notify("PG: graph already has history. Use /pg init --force to replace it, or --expert <path> to import", "warning");
            return;
          }
          let graph;
          const expert = flags.get("expert");
          if (expert) {
            try {
              const { readFileSync } = await import("node:fs");
              graph = JSON.parse(readFileSync(resolveStorePath(ctx.cwd, expert), "utf8")) as ReturnType<typeof createSkeletonGraph>;
              const errs = validateGraph(graph);
              if (errs.length > 0) {
                ctx.ui.notify(`PG: expert graph invalid: ${errs.slice(0, 3).join("; ")}`, "error");
                return;
              }
            } catch (e) {
              ctx.ui.notify(`PG: could not load expert graph: ${String(e)}`, "error");
              return;
            }
          } else if (booleans.has("scratch")) {
            graph = createEmptyGraph(flags.get("name") ?? "default");
          } else {
            graph = createSkeletonGraph(flags.get("name") ?? "default");
          }
          const fresh = createEmptyStore(graph);
          fresh.history = booleans.has("keep-history") ? store.history : [];
          fresh.stats = { ...store.stats, createdAt: Date.now(), updatedAt: Date.now() };
          Object.assign(store, fresh);
          rt.save();
          ctx.ui.notify(`PG: initialized "${graph.name}" (${graph.nodes.length} nodes, ${graph.edges.length} edges)`, "info");
          break;
        }

        case "graph": {
          const g = store.graph;
          if (booleans.has("localize")) {
            const action = rt.getTracker().lastToolName;
            const active = action ? localize(g, action) : "Start";
            const hood = active ? neighborhood(g, active, config.guidance.hops) : { nodeIds: new Set<string>(), edges: g.edges };
            const text = formatNeighborhood(g, active, hood);
            const target = writeOut(ctx, "procedural-graph.out.md", text);
            ctx.ui.notify(`PG localize: ${active} → ${target}`, "info");
            break;
          }
          const text = formatGraph(g, booleans.has("full") ? 1000 : 200);
          const target = writeOut(ctx, "procedural-graph.out.md", text);
          ctx.ui.notify(`PG graph: ${g.nodes.length}N/${g.edges.length}E → ${target}`, "info");
          break;
        }

        case "task": {
          const tracker = rt.getTracker();
          if (rest[0] === "start") {
            tracker.startTask(rest.slice(1).join(" ") || "(manual task)");
            ctx.ui.notify(`PG: task started (${tracker.currentTask?.id})`, "info");
            return;
          }
          if (rest[0] === "done" || rest[0] === "end") {
            const v = parseVerdict(flags.get("verdict"));
            const finished = tracker.endTask();
            if (!finished) {
              ctx.ui.notify("PG: no active task to finish", "warning");
              return;
            }
            if (v) {
              store.history.push({ ...finished, verdict: v.verdict, score: v.score, note: flags.get("note"), evolved: false });
              rt.save();
              ctx.ui.notify(`PG: task ${finished.id} recorded as ${v.verdict}`, "info");
            } else {
              ctx.ui.notify("PG: task finished without verdict (use --verdict success|fail|score:N)", "info");
            }
            return;
          }
          ctx.ui.notify("PG: usage — /pg task start [name] | /pg task done --verdict success|fail|score:N", "info");
          break;
        }

        case "verdict": {
          const tracker = rt.getTracker();
          const arg = rest[0] ?? flags.get("verdict") ?? "";
          const v = parseVerdict(arg);
          const note = flags.get("note") ?? rest.slice(1).join(" ");
          const task = tracker.currentTask;
          if (!task) {
            ctx.ui.notify("PG: no active task to mark", "warning");
            return;
          }
          if (!v) {
            ctx.ui.notify("PG: usage — /pg verdict success|fail|score:N [note]", "warning");
            return;
          }
          const finished = tracker.endTask();
          if (!finished) return;
          store.history.push({ ...finished, verdict: v.verdict, score: v.score, note: note || undefined, evolved: false });
          rt.save();
          ctx.ui.notify(`PG: marked ${finished.id} as ${v.verdict}${v.score !== undefined ? ` (${v.score})` : ""}`, "info");
          break;
        }

        case "evolve": {
          const ok = await maybeEvolve({ store, config, ctx, graphFilePath: rt.getGraphFilePath() }, booleans.has("force"));
          if (ok) rt.save();
          break;
        }

        case "review": {
          if (!store.staged) {
            ctx.ui.notify("PG: nothing staged", "info");
            return;
          }
          const st = store.staged;
          const added = st.edits.filter((e) => e.op === "add_edge" || e.op === "add_node");
          const removed = st.edits.filter((e) => e.op === "delete_edge" || e.op === "delete_node");
          const revised = st.edits.filter((e) => e.op === "revise_edge");
          const cur = store.graph;
          const lines = [
            `# PG review (${new Date(st.ts).toISOString()})`,
            `Edits: ${st.edits.length} (${added.length} add, ${removed.length} delete, ${revised.length} revise)`,
            `Nodes: ${cur.nodes.length} → ${st.candidate.nodes.length} | Edges: ${cur.edges.length} → ${st.candidate.edges.length}`,
            "",
            ...st.edits.map((e) => `- ${JSON.stringify(e)}`),
          ];
          if (config.evolution.validationCommand) {
            const candidatePath = rt.getGraphFilePath().replace(/\.json$/, ".candidate.json");
            writeFileSync(candidatePath, JSON.stringify(st.candidate, null, 2), "utf8");
            const result = await runValidationCommand(config.evolution.validationCommand, candidatePath, rt.getGraphFilePath(), ctx.cwd);
            lines.push("", `validation: ${result.ok ? "PASSED → /pg accept" : "FAILED → /pg reject"}`);
          } else {
            lines.push("", "Run /pg accept or /pg reject");
          }
          const target = writeOut(ctx, "procedural-graph.review.md", lines.join("\n"));
          ctx.ui.notify(`PG review: ${st.edits.length} edits (${added.length}+/${removed.length}-/${revised.length}~) → ${target}`, "info");
          break;
        }

        case "accept": {
          if (commitStaged({ store, config, ctx, graphFilePath: rt.getGraphFilePath() })) {
            rt.save();
            ctx.ui.notify("PG: staged edits committed", "info");
          } else {
            ctx.ui.notify("PG: nothing to accept", "warning");
          }
          break;
        }

        case "reject": {
          const reason = rest.join(" ") || flags.get("reason") || undefined;
          if (rejectStaged({ store, config, ctx, graphFilePath: rt.getGraphFilePath() }, reason)) {
            rt.save();
            ctx.ui.notify("PG: staged edits rejected → rejection memory", "info");
          } else {
            ctx.ui.notify("PG: nothing to reject", "warning");
          }
          break;
        }

        case "edit": {
          const op = rest[0];
          if (!op) {
            ctx.ui.notify("PG: usage — /pg edit add-node|add-edge|delete-node|delete-edge|revise-edge …", "info");
            return;
          }
          const edit = buildEdit(op, rest.slice(1), flags);
          if (!edit) {
            ctx.ui.notify("PG: could not parse edit (see README for syntax)", "warning");
            return;
          }
          const applied = applyEdits(store.graph, [edit]);
          if (!applied.ok) {
            ctx.ui.notify(`PG: edit rejected: ${applied.errors.slice(0, 3).join("; ")}`, "error");
            return;
          }
          store.graph = applied.graph;
          rt.save();
          ctx.ui.notify("PG: edit applied", "info");
          break;
        }

        case "disable": {
          config.enabled = false;
          rt.saveConfig();
          ctx.ui.notify("PG: disabled (guidance will not be injected). /pg enable to re-enable", "info");
          break;
        }

        case "enable": {
          config.enabled = true;
          rt.saveConfig();
          ctx.ui.notify("PG: enabled", "info");
          break;
        }

        case "export": {
          const out = flags.get("path") ?? rest[0] ?? ".pi/procedural-graph.export.json";
          const target = resolveStorePath(ctx.cwd, out);
          writeFileSync(target, JSON.stringify(store.graph, null, 2), "utf8");
          ctx.ui.notify(`PG: graph exported to ${target}`, "info");
          break;
        }

        case "reset": {
          const wipeHistory = booleans.has("history");
          if (ctx.hasUI && !booleans.has("yes")) {
            const ok = await ctx.ui.confirm(
              "Reset procedural graph",
              wipeHistory ? "Replace graph AND clear history + rejection memory?" : "Replace graph with the default skeleton?",
            );
            if (!ok) return;
          }
          const g = createSkeletonGraph(store.graph.name || "default");
          const fresh = createEmptyStore(g);
          fresh.history = wipeHistory ? [] : store.history;
          fresh.rejectionMemory = wipeHistory ? [] : store.rejectionMemory;
          fresh.stats = { ...store.stats, createdAt: Date.now(), updatedAt: Date.now() };
          Object.assign(store, fresh);
          rt.save();
          ctx.ui.notify(`PG: reset to skeleton (${g.nodes.length} nodes, ${g.edges.length} edges)`, "info");
          break;
        }

        default: {
          ctx.ui.notify(
            "PG: unknown subcommand. Try: status, init, graph, task, verdict, evolve, review, accept, reject, edit, disable, enable, export, reset",
            "warning",
          );
        }
      }
    },
  });
}

function parseVerdict(arg: string | undefined): { verdict: "success" | "fail"; score?: number } | null {
  if (!arg) return null;
  if (arg === "success" || arg === "ok" || arg === "pass") return { verdict: "success" };
  if (arg === "fail" || arg === "failure") return { verdict: "fail" };
  const m = /^score:(\d+(?:\.\d+)?)$/.exec(arg.trim());
  if (m) {
    const score = Math.max(0, Math.min(1, parseFloat(m[1])));
    return { verdict: score >= 0.5 ? "success" : "fail", score };
  }
  return null;
}

function writeOut(ctx: { cwd: string }, name: string, body: string): string {
  const target = resolveStorePath(ctx.cwd, `.pi/${name}`);
  writeFileSync(target, body, "utf8");
  return target;
}

function buildEdit(op: string, rest: string[], flags: Map<string, string>): Edit | null {
  switch (op) {
    case "add-node": {
      const id = rest[0];
      if (!id) return null;
      const kindRaw = flags.get("kind") ?? "step";
      const kind = kindRaw === "tool" || kindRaw === "state" ? kindRaw : "step";
      return { op: "add_node", id, kind, label: flags.get("label"), description: flags.get("desc") ?? flags.get("description") };
    }
    case "add-edge": {
      const [source, relation, target] = rest;
      if (!source || !relation || !target) return null;
      return {
        op: "add_edge",
        source,
        relation,
        target,
        attrs: {
          condition: flags.get("condition"),
          guidance: flags.get("guidance"),
          pitfalls: flags.get("pitfalls"),
        },
      };
    }
    case "delete-node": {
      const id = rest[0];
      return id ? { op: "delete_node", id } : null;
    }
    case "delete-edge": {
      const [source, relation, target] = rest;
      return source && relation && target ? { op: "delete_edge", source, relation, target } : null;
    }
    case "revise-edge": {
      const [source, relation, target] = rest;
      if (!source || !relation || !target) return null;
      return {
        op: "revise_edge",
        source,
        relation,
        target,
        attrs: {
          condition: flags.get("condition"),
          guidance: flags.get("guidance"),
          pitfalls: flags.get("pitfalls"),
        },
      };
    }
    default:
      return null;
  }
}