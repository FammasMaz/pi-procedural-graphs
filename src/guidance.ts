/**
 * Step-level guidance (paper Section 3.2: locate, extract, generate).
 *
 * inject mode: the localized h-hop subgraph is formatted and appended to the
 * model context at zero extra cost (raw injection is a configuration the paper
 * itself ablates). llm mode: a separate model call first distills the
 * neighborhood + recent trajectory into situational guidance g_t, then injects.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { PGConfig } from "./config";
import { formatNeighborhood, localize, neighborhood, type PGStore } from "./graph";
import { formatSteps, type Tracker } from "./tracker";

const GUIDANCE_SYSTEM_PROMPT = `You are the guidance model of a Procedural Graph system for an LLM coding agent. A procedural graph stores admissible transitions between procedures (tool calls, reasoning steps, task states), each annotated with condition, guidance, and pitfalls. Given the current procedure, the transitions reachable from it, and the agent's recent steps, produce situational guidance for the NEXT action.

Rules:
- Identify the agent's immediate goal and the most relevant next transition(s).
- Bias the next action without dictating it; preserve reasoning freedom.
- Surface formatting or logical pitfalls to avoid.
- Output 3-6 concise lines. No preamble, no markdown.`;

export interface GuidanceResult {
  messages: AgentMessage[];
  injected: boolean;
  matched: boolean;
}

/**
 * Attempt to append step-level procedural guidance to the outgoing model
 * context. Returns null when no injection should happen this step.
 */
export async function injectGuidance(
  messages: AgentMessage[],
  store: PGStore,
  tracker: Tracker,
  config: PGConfig,
  ctx: ExtensionContext,
): Promise<GuidanceResult | null> {
  const graph = store.graph;
  if (graph.edges.length === 0) return null; // nothing learned yet; don't pollute context

  const action = tracker.lastToolName;
  const active = action ? localize(graph, action) : "Start";
  const matched = active !== null;

  if (!matched && !config.guidance.injectOnMiss) {
    store.stats.misses++;
    return null;
  }
  if (!matched && graph.nodes.length > config.guidance.maxGraphNodesForFullInjection) {
    store.stats.misses++;
    return null;
  }

  const hops = config.guidance.hops;
  const hood = matched
    ? neighborhood(graph, active, hops)
    : { nodeIds: new Set(graph.nodes.map((n) => n.id)), edges: graph.edges };

  if (hood.edges.length === 0) return null;

  const windowSteps = tracker.window(config.guidance.window);
  const query = tracker.currentTask?.query ?? "";
  const base = formatNeighborhood(graph, matched ? active : null, hood);

  let guidanceText: string;
  if (config.guidance.mode === "llm") {
    guidanceText = await distillGuidance({ base, query, windowSteps }, config, ctx);
  } else {
    guidanceText = base;
  }

  const block = [
    "<procedural-guidance source=\"pi-procedural-graphs\" note=\"automatic step-level guidance, not a user message\">",
    guidanceText,
    "",
    "Recent steps:",
    formatSteps(windowSteps),
    "</procedural-guidance>",
  ].join("\n");

  const guidanceMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: block }],
    timestamp: Date.now(),
  };

  store.stats.injections++;
  if (matched) store.stats.matches++;
  else store.stats.misses++;

  return { messages: [...messages, guidanceMessage], injected: true, matched };
}

async function distillGuidance(
  input: { base: string; query: string; windowSteps: ReturnType<Tracker["window"]> },
  config: PGConfig,
  ctx: ExtensionContext,
): Promise<string> {
  if (!ctx.model) {
    // No model available; fall back to raw injection.
    return input.base;
  }
  const userText = [
    `Query: ${input.query || "(no explicit query)"}`,
    "",
    "Recent steps:",
    formatSteps(input.windowSteps),
    "",
    "Reachable transitions:",
    input.base,
  ].join("\n");

  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt: GUIDANCE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
      },
      {
        maxTokens: config.guidance.maxTokens,
        signal: ctx.signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
      },
    );
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
    return text.length > 0 ? text : input.base;
  } catch (error) {
    console.error("[procedural-graphs] guidance distillation failed, falling back to raw injection:", error);
    return input.base;
  }
}