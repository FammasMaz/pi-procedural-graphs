/**
 * Per-project configuration. Loaded from `.pi/procedural-graph.config.json`
 * (optional); defaults match the paper: h=2 hop neighborhood, w=3 trajectory
 * window, inject mode by default (raw injection is a paper-supported ablation).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GuidanceConfig {
  /** "inject" = raw subgraph into context (free). "llm" = separate distillation call per step. */
  mode: "inject" | "llm";
  /** h in the paper: expand outgoing transitions up to h steps (default 2). */
  hops: number;
  /** w in the paper: recent trajectory window length (default 3). */
  window: number;
  maxTokens: number;
  /** On localization miss, inject the full graph if it is small enough. */
  injectOnMiss: boolean;
  /** Only inject the full graph on miss if node count is at most this. */
  maxGraphNodesForFullInjection: number;
}

export interface EvolutionConfig {
  /** Auto-run the refiner once this many un-evolved tasks with verdicts accumulate. */
  batchSize: number;
  /** Minimum verdict-bearing tasks required for a forced /pg evolve. */
  minBatchForForce: number;
  /**
   * true: structurally-valid candidate graphs are committed without user review
   * (and via validationCommand when set). false: stage for /pg review.
   */
  autoApprove: boolean;
  /**
   * Optional shell command used as the validation gate. Run with cwd=project and
   * env PG_CANDIDATE_FILE set to the candidate graph JSON. Exit 0 = pass.
   */
  validationCommand: string | null;
  refinerMaxTokens: number;
  /** Trajectory context cap; keeps the END of trajectories (paper keeps final L tokens). */
  maxTrajectoryTokens: number;
  maxRejectionMemories: number;
}

export interface VerdictConfig {
  /**
   * Optional shell command that derives a task verdict. Run at task end with
   * cwd=project. Exit 0 = success, non-zero = fail. If null, verdicts are
   * only recorded from /pg verdict or /pg task done.
   */
  command: string | null;
  /** If true, a task with any errored tool result is auto-marked fail. */
  autoFailOnError: boolean;
}

export interface PGConfig {
  enabled: boolean;
  /** Relative to project cwd. */
  graphFile: string;
  guidance: GuidanceConfig;
  evolution: EvolutionConfig;
  verdict: VerdictConfig;
}

export const DEFAULT_CONFIG: PGConfig = {
  enabled: true,
  graphFile: ".pi/procedural-graph.json",
  guidance: {
    mode: "inject",
    hops: 2,
    window: 3,
    maxTokens: 400,
    injectOnMiss: true,
    maxGraphNodesForFullInjection: 20,
  },
  evolution: {
    batchSize: 5,
    minBatchForForce: 2,
    autoApprove: false,
    validationCommand: null,
    refinerMaxTokens: 2000,
    maxTrajectoryTokens: 8000,
    maxRejectionMemories: 10,
  },
  verdict: {
    command: null,
    autoFailOnError: false,
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const baseVal = out[k];
    if (isPlainObject(v) && isPlainObject(baseVal)) {
      out[k] = deepMerge(baseVal, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(cwd: string): PGConfig {
  const path = resolve(cwd, ".pi", "procedural-graph.config.json");
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const merged = deepMerge(DEFAULT_CONFIG, raw);
    if (merged.guidance.mode !== "inject" && merged.guidance.mode !== "llm") merged.guidance.mode = "inject";
    return merged;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}