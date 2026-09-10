/**
 * Procedural Graph data model + persistence.
 *
 * Faithful to arXiv:2609.09153:
 *   G = (V, R, E, Phi),  E ⊆ V × R × V
 * Nodes abstract tool calls, reasoning steps, and task states.
 * Edges are directed, attributed triplets (procedure --relation--> procedure)
 * whose attributes describe when/how to take the transition and what to avoid.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type NodeKind = "tool" | "step" | "state";

export interface PGNode {
  id: string;
  kind: NodeKind;
  label?: string;
  description?: string;
}

/** Edge attributes per the paper's schema: condition, guidance, pitfalls. */
export interface EdgeAttrs {
  condition?: string;
  guidance?: string;
  pitfalls?: string;
}

export interface PGEdge {
  id: string;
  source: string;
  relation: string;
  target: string;
  attrs: EdgeAttrs;
}

export interface ProceduralGraph {
  version: 1;
  name: string;
  description?: string;
  nodes: PGNode[];
  edges: PGEdge[];
}

export type Verdict = "success" | "fail";

export interface StepRecord {
  tool: string;
  args?: string;
  ok: boolean;
  obs?: string;
}

export interface TaskRecord {
  id: string;
  query: string;
  verdict: Verdict;
  score?: number;
  note?: string;
  steps: StepRecord[];
  startedAt: number;
  endedAt: number;
  /** Set once this task has been consumed by an evolution round. */
  evolved: boolean;
}

export type Edit =
  | { op: "add_node"; id: string; kind: NodeKind; label?: string; description?: string }
  | { op: "add_edge"; source: string; relation: string; target: string; attrs?: EdgeAttrs }
  | { op: "delete_node"; id: string }
  | { op: "delete_edge"; source: string; relation: string; target: string }
  | { op: "revise_edge"; source: string; relation: string; target: string; attrs?: EdgeAttrs };

export interface RejectionRecord {
  ts: number;
  reason?: string;
  edits: Edit[];
  graphSummary: { nodes: number; edges: number };
  successes: number;
  failures: number;
}

export interface StagedSet {
  ts: number;
  edits: Edit[];
  candidate: ProceduralGraph;
  taskIds: string[];
}

export interface PGStore {
  version: 1;
  graph: ProceduralGraph;
  history: TaskRecord[];
  rejectionMemory: RejectionRecord[];
  staged: StagedSet | null;
  stats: {
    injections: number;
    matches: number;
    misses: number;
    commits: number;
    rejections: number;
    evolutions: number;
    createdAt: number;
    updatedAt: number;
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createEmptyGraph(name = "default"): ProceduralGraph {
  return {
    version: 1,
    name,
    nodes: [{ id: "Start", kind: "step", label: "Start" }],
    edges: [],
  };
}

/**
 * A minimal, neutral coding-agent skeleton ("start from a minimal skeleton"
 * in the paper). Evolution grows this into a project-specific graph.
 */
export function createSkeletonGraph(name = "default"): ProceduralGraph {
  const nodes: PGNode[] = [
    { id: "Start", kind: "step", label: "Start" },
    { id: "tool:read", kind: "tool", label: "read" },
    { id: "tool:grep", kind: "tool", label: "grep" },
    { id: "tool:ls", kind: "tool", label: "ls" },
    { id: "tool:find", kind: "tool", label: "find" },
    { id: "tool:edit", kind: "tool", label: "edit" },
    { id: "tool:write", kind: "tool", label: "write" },
    { id: "tool:bash", kind: "tool", label: "bash" },
    { id: "state:needs_verification", kind: "state", label: "Verification needed" },
  ];
  const edges: PGEdge[] = [
    {
      id: edgeId("Start", "leads_to", "tool:read"),
      source: "Start",
      relation: "leads_to",
      target: "tool:read",
      attrs: {
        guidance: "Read the relevant files first; understand before modifying anything.",
        pitfalls: "Do not edit code you have not read.",
      },
    },
    {
      id: edgeId("Start", "leads_to", "tool:grep"),
      source: "Start",
      relation: "leads_to",
      target: "tool:grep",
      attrs: {
        condition: "Need to locate where a symbol or string is used.",
        guidance: "Search for references before editing them.",
      },
    },
    {
      id: edgeId("Start", "leads_to", "tool:ls"),
      source: "Start",
      relation: "leads_to",
      target: "tool:ls",
      attrs: {
        condition: "Need to see the project layout.",
        guidance: "List the directory to orient before exploring deeper.",
      },
    },
    {
      id: edgeId("Start", "leads_to", "tool:find"),
      source: "Start",
      relation: "leads_to",
      target: "tool:find",
      attrs: {
        condition: "Need to locate files by name or pattern.",
        guidance: "Use find to locate files, then read the relevant ones.",
      },
    },
    {
      id: edgeId("tool:grep", "leads_to", "tool:read"),
      source: "tool:grep",
      relation: "leads_to",
      target: "tool:read",
      attrs: {
        guidance: "Open the files where matches were found before editing.",
      },
    },
    {
      id: edgeId("tool:find", "leads_to", "tool:read"),
      source: "tool:find",
      relation: "leads_to",
      target: "tool:read",
      attrs: {
        guidance: "Open the files you located before editing.",
      },
    },
    {
      id: edgeId("tool:read", "leads_to", "tool:edit"),
      source: "tool:read",
      relation: "leads_to",
      target: "tool:edit",
      attrs: {
        condition: "You understand the code you read.",
        guidance: "Make the smallest change that satisfies the request.",
        pitfalls: "Do not refactor unrelated code; preserve existing conventions.",
      },
    },
    {
      id: edgeId("tool:read", "leads_to", "tool:write"),
      source: "tool:read",
      relation: "leads_to",
      target: "tool:write",
      attrs: {
        condition: "A new file is needed and you understand where it belongs.",
        guidance: "Create the file with minimal, focused content.",
      },
    },
    {
      id: edgeId("tool:edit", "leads_to", "tool:bash"),
      source: "tool:edit",
      relation: "leads_to",
      target: "tool:bash",
      attrs: {
        condition: "After modifying code.",
        guidance: "Run the relevant tests or a build to verify your change.",
        pitfalls: "Do not claim success without verification.",
      },
    },
    {
      id: edgeId("tool:write", "leads_to", "tool:bash"),
      source: "tool:write",
      relation: "leads_to",
      target: "tool:bash",
      attrs: {
        condition: "After writing a file.",
        guidance: "Run tests or a build to verify the new file integrates.",
      },
    },
    {
      id: edgeId("tool:bash", "leads_to", "tool:read"),
      source: "tool:bash",
      relation: "leads_to",
      target: "tool:read",
      attrs: {
        condition: "Command output reveals more context.",
        guidance: "Read the relevant files indicated by the output.",
      },
    },
    {
      id: edgeId("tool:bash", "if_failed", "state:needs_verification"),
      source: "tool:bash",
      relation: "if_failed",
      target: "state:needs_verification",
      attrs: {
        condition: "A command failed or tests are red.",
        guidance: "Diagnose the error before retrying; do not repeat the same action unchanged.",
        pitfalls: "Do not blindly rerun the same failing command.",
      },
    },
    {
      id: edgeId("state:needs_verification", "leads_to", "tool:read"),
      source: "state:needs_verification",
      relation: "leads_to",
      target: "tool:read",
      attrs: {
        guidance: "Read the failing code or output to understand the root cause.",
      },
    },
  ];
  return { version: 1, name, nodes, edges };
}

export function edgeId(source: string, relation: string, target: string): string {
  return `${source} --${relation}--> ${target}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateGraph(g: ProceduralGraph): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (!n.id || !n.id.trim()) {
      errors.push("node with empty id");
      continue;
    }
    if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (n.kind !== "tool" && n.kind !== "step" && n.kind !== "state") {
      errors.push(`node "${n.id}" has invalid kind "${String(n.kind)}"`);
    }
  }
  const edgeIds = new Set<string>();
  for (const e of g.edges) {
    if (!e.source || !e.relation || !e.target) {
      errors.push(`edge with missing source/relation/target: ${e.id}`);
      continue;
    }
    if (!ids.has(e.source)) errors.push(`edge "${e.id}" references unknown source node "${e.source}"`);
    if (!ids.has(e.target)) errors.push(`edge "${e.id}" references unknown target node "${e.target}"`);
    if (edgeIds.has(e.id)) errors.push(`duplicate edge id "${e.id}"`);
    edgeIds.add(e.id);
  }
  return errors;
}

export function isGraphValid(g: ProceduralGraph): boolean {
  return validateGraph(g).length === 0;
}

// ---------------------------------------------------------------------------
// Localization + neighborhood (Section 3.2: locate, extract)
// ---------------------------------------------------------------------------

/** Match the agent's last procedure (tool name) to a graph node. */
export function localize(g: ProceduralGraph, action: string | null | undefined): string | null {
  if (!action) return null;
  const a = action.trim();
  if (!a) return null;
  for (const n of g.nodes) {
    if (n.id === a || n.id === `tool:${a}`) return n.id;
  }
  for (const n of g.nodes) {
    if (n.kind === "tool" && (n.label === a || (n.label && n.label.toLowerCase() === a.toLowerCase()))) return n.id;
  }
  return null;
}

export interface Neighborhood {
  nodeIds: Set<string>;
  edges: PGEdge[];
}

/** Extract the directed h-hop outgoing neighborhood of a node (or empty set). */
export function neighborhood(g: ProceduralGraph, nodeId: string | null, hops: number): Neighborhood {
  if (!nodeId) return { nodeIds: new Set(), edges: [] };
  const out = new Map<string, PGEdge[]>();
  for (const e of g.edges) {
    const list = out.get(e.source) ?? [];
    list.push(e);
    out.set(e.source, list);
  }
  const nodeIds = new Set<string>([nodeId]);
  const edges: PGEdge[] = [];
  let frontier = [nodeId];
  for (let h = 0; h < hops && frontier.length > 0; h++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of out.get(cur) ?? []) {
        if (!edges.some((x) => x.id === e.id)) edges.push(e);
        if (!nodeIds.has(e.target)) {
          nodeIds.add(e.target);
          next.push(e.target);
        }
      }
    }
    frontier = next;
  }
  return { nodeIds, edges };
}

// ---------------------------------------------------------------------------
// Edits (Section 3.3, Step 2: feedback-driven mutation)
// ---------------------------------------------------------------------------

/**
 * Apply a structured edit set to a COPY of the graph. Adding an edge whose
 * endpoint does not exist auto-creates a step node (matches the paper's
 * "inserting missing verification nodes or edges"). Deleting a node cascades
 * to incident edges.
 */
export function applyEdits(g: ProceduralGraph, edits: Edit[]): { ok: boolean; graph: ProceduralGraph; errors: string[] } {
  const graph: ProceduralGraph = JSON.parse(JSON.stringify(g));
  const errors: string[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const edgeKeys = new Set(graph.edges.map((e) => `${e.source}|${e.relation}|${e.target}`));

  for (const edit of edits) {
    switch (edit.op) {
      case "add_node": {
        if (!edit.id || !edit.id.trim()) {
          errors.push("add_node with empty id");
          break;
        }
        if (nodeIds.has(edit.id)) {
          errors.push(`add_node: node "${edit.id}" already exists`);
          break;
        }
        graph.nodes.push({ id: edit.id, kind: edit.kind, label: edit.label, description: edit.description });
        nodeIds.add(edit.id);
        break;
      }
      case "add_edge": {
        if (!edit.source || !edit.relation || !edit.target) {
          errors.push("add_edge with missing source/relation/target");
          break;
        }
        const key = `${edit.source}|${edit.relation}|${edit.target}`;
        if (edgeKeys.has(key)) {
          errors.push(`add_edge: edge "${key}" already exists`);
          break;
        }
        if (!nodeIds.has(edit.source)) {
          graph.nodes.push({ id: edit.source, kind: "step" });
          nodeIds.add(edit.source);
        }
        if (!nodeIds.has(edit.target)) {
          graph.nodes.push({ id: edit.target, kind: "step" });
          nodeIds.add(edit.target);
        }
        graph.edges.push({
          id: edgeId(edit.source, edit.relation, edit.target),
          source: edit.source,
          relation: edit.relation,
          target: edit.target,
          attrs: edit.attrs ?? {},
        });
        edgeKeys.add(key);
        break;
      }
      case "delete_edge": {
        const key = `${edit.source}|${edit.relation}|${edit.target}`;
        if (!edgeKeys.has(key)) {
          errors.push(`delete_edge: edge "${key}" does not exist`);
          break;
        }
        graph.edges = graph.edges.filter((e) => `${e.source}|${e.relation}|${e.target}` !== key);
        edgeKeys.delete(key);
        break;
      }
      case "delete_node": {
        if (!nodeIds.has(edit.id)) {
          errors.push(`delete_node: node "${edit.id}" does not exist`);
          break;
        }
        if (edit.id === "Start") {
          errors.push("delete_node: refusing to delete Start");
          break;
        }
        graph.nodes = graph.nodes.filter((n) => n.id !== edit.id);
        nodeIds.delete(edit.id);
        const removed = graph.edges.filter((e) => e.source === edit.id || e.target === edit.id);
        for (const e of removed) edgeKeys.delete(`${e.source}|${e.relation}|${e.target}`);
        graph.edges = graph.edges.filter((e) => e.source !== edit.id && e.target !== edit.id);
        break;
      }
      case "revise_edge": {
        const key = `${edit.source}|${edit.relation}|${edit.target}`;
        const e = graph.edges.find((x) => `${x.source}|${x.relation}|${x.target}` === key);
        if (!e) {
          errors.push(`revise_edge: edge "${key}" does not exist`);
          break;
        }
        e.attrs = edit.attrs ?? {};
        break;
      }
      default: {
        const unknown = edit as { op: string };
        errors.push(`unknown edit op "${unknown.op}"`);
      }
    }
  }

  const structural = validateGraph(graph);
  if (structural.length > 0) errors.push(...structural);
  return { ok: errors.length === 0, graph, errors };
}

// ---------------------------------------------------------------------------
// Formatting (for prompts and /pg output)
// ---------------------------------------------------------------------------

export function formatGraph(g: ProceduralGraph, maxLines = 200): string {
  const lines: string[] = [];
  lines.push(`# Procedural Graph: ${g.name}`);
  lines.push(`Nodes (${g.nodes.length}): ${g.nodes.map((n) => n.id).join(", ")}`);
  for (const e of g.edges) {
    const attrs: string[] = [];
    if (e.attrs.condition) attrs.push(`condition: ${e.attrs.condition}`);
    if (e.attrs.guidance) attrs.push(`guidance: ${e.attrs.guidance}`);
    if (e.attrs.pitfalls) attrs.push(`pitfalls: ${e.attrs.pitfalls}`);
    lines.push(`${e.source} --${e.relation}--> ${e.target}${attrs.length ? ` | ${attrs.join(" | ")}` : ""}`);
    if (lines.length >= maxLines) {
      lines.push(`… (${g.edges.length} edges total)`);
      break;
    }
  }
  return lines.join("\n");
}

export function formatNeighborhood(g: ProceduralGraph, active: string | null, hood: Neighborhood): string {
  const lines: string[] = [];
  lines.push(`Active procedure: ${active ?? "unknown"}`);
  if (hood.edges.length === 0) {
    lines.push("No transitions recorded from this procedure yet.");
    return lines.join("\n");
  }
  lines.push("Admissible transitions reachable from here:");
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

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function createEmptyStore(graph: ProceduralGraph): PGStore {
  const now = Date.now();
  return {
    version: 1,
    graph,
    history: [],
    rejectionMemory: [],
    staged: null,
    stats: { injections: 0, matches: 0, misses: 0, commits: 0, rejections: 0, evolutions: 0, createdAt: now, updatedAt: now },
  };
}

export function loadStore(path: string): PGStore | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as PGStore;
    if (!raw || raw.version !== 1 || !raw.graph || !Array.isArray(raw.history)) return null;
    if (!Array.isArray(raw.rejectionMemory)) raw.rejectionMemory = [];
    if (!raw.staged) raw.staged = null;
    if (!raw.stats) {
      raw.stats = { injections: 0, matches: 0, misses: 0, commits: 0, rejections: 0, evolutions: 0, createdAt: Date.now(), updatedAt: Date.now() };
    }
    return raw;
  } catch {
    return null;
  }
}

export function saveStore(path: string, store: PGStore): void {
  store.stats.updatedAt = Date.now();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

export function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(args).slice(0, 200);
  }
}

/** Extract readable text from a tool result object. */
export function summarizeResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  const r = result as { content?: Array<{ type?: string; text?: string }>; text?: string };
  let text = "";
  if (Array.isArray(r.content)) {
    text = r.content
      .filter((c): c is { type: string; text: string } => !!c && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  } else if (typeof r.text === "string") {
    text = r.text;
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function truncateEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…${text.slice(text.length - maxChars)}`;
}

export function resolveStorePath(cwd: string, graphFile: string): string {
  return resolve(cwd, graphFile);
}