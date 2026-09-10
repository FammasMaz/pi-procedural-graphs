/**
 * In-process integration harness. Loads the REAL extension entrypoint
 * (src/index.ts) and drives it with a mock pi ExtensionAPI + mock context.
 *
 * Isolation: no pi process is spawned, no settings files are touched, no
 * network/model calls happen (modelRegistry.complete is a stub returning
 * canned text; ctx.model is a fake string). State lands only in a fresh /tmp
 * project dir.
 *
 * Run: npx tsx scripts/harness.ts   (or: npm run integration)
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extensionFactory from "../src/index.ts";

type Handler = (event: any, ctx: any) => unknown;

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pg-harness-"));
  const cwd = resolve(dir, "proj");
  mkdirSync(join(cwd, ".pi"), { recursive: true });

  writeFileSync(
    join(cwd, ".pi", "procedural-graph.config.json"),
    JSON.stringify({
      enabled: true,
      guidance: { mode: "inject", hops: 2, window: 3, injectOnMiss: true, maxGraphNodesForFullInjection: 20 },
      evolution: { batchSize: 1, minBatchForForce: 1, autoApprove: false, validationCommand: null, refinerMaxTokens: 2000, maxTrajectoryTokens: 8000, maxRejectionMemories: 10 },
      verdict: { command: "exit 0", autoFailOnError: false },
    }, null, 2),
  );

  const notify: string[] = [];
  const status = new Map<string, string | undefined>();
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const registry = {
    tool: null as { name: string; execute: (...a: any[]) => Promise<any> } | null,
  };

  // Shared mock model registry — mutable so later tests can swap canned output.
  const modelRegistry = {
    complete: async () => ({
      content: [
        {
          type: "text",
          text: `[{"op":"add_edge","source":"tool:read","relation":"leads_to","target":"tool:bash","attrs":{"condition":"when exploring","guidance":"run the command to verify","pitfalls":"don't guess"}}]`,
        },
      ],
    }),
  };

  const pi = {
    on: (evt: string, h: Handler) => handlers.set(evt, h),
    registerCommand: (name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, def),
    registerTool: (def: { name: string; execute: (...a: any[]) => Promise<any> }) => { registry.tool = def; },
  };

  const ctx = (overrides: Record<string, unknown> = {}) => ({
    cwd,
    ui: { notify: (m: string) => notify.push(m), setStatus: (k: string, v?: string) => status.set(k, v), confirm: async () => true },
    model: "mock-model",
    signal: new AbortController().signal,
    modelRegistry,
    ...overrides,
  });

  const storePath = join(cwd, ".pi", "procedural-graph.json");
  const readStore = () => JSON.parse(readFileSync(storePath, "utf8"));
  const fakeMessages: any[] = [{ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 }];

  // ------------------------------------------------------------------ setup
  extensionFactory(pi as any);
  check("factory registered 8 event handlers", handlers.size === 8);
  check("factory registered /pg command", commands.has("pg"));
  check("factory registered pg_status tool", registry.tool?.name === "pg_status");

  // --------------------------------------------------------------- session
  await handlers.get("session_start")!({}, ctx());
  check("session_start created store file", existsSync(storePath));
  check("skeleton graph initialized (9 nodes / 13 edges)", readStore().graph.nodes.length === 9 && readStore().graph.edges.length === 13);
  check("status set", status.get("pg") === "PG 9N/13E");

  // ------------------------------------------------- Turn 1: localize-match
  await handlers.get("before_agent_start")!({ prompt: "Add a test for the store" }, ctx());
  await handlers.get("turn_start")!({}, ctx());
  await handlers.get("tool_execution_start")!({ toolName: "read", args: { path: "src/store.ts" } }, ctx());
  await handlers.get("tool_execution_end")!({ toolName: "read", isError: false, result: { content: [{ type: "text", text: "export function saveStore() {}" }] } }, ctx());

  const injectResult = (await handlers.get("context")!({ messages: fakeMessages }, ctx())) as { messages: any[] } | undefined;
  check("context event appended guidance", injectResult !== undefined && injectResult.messages.length === fakeMessages.length + 1);
  const injectedText = injectResult?.messages.at(-1)?.content?.[0]?.text ?? "";
  check("guidance block marked automatic", injectedText.includes("<procedural-guidance"));
  check("guidance localized to read", injectedText.includes("tool:read --leads_to-->"));
  check("guidance includes recent steps", injectedText.includes("Recent steps:"));
  // Injection stats are in-memory until the next save boundary; /pg status is
  // the real surface for them (it reads the live store).
  const cmd = commands.get("pg")!;
  const runCmd = async (args: string) => cmd.handler(args, ctx());
  await runCmd("status");
  check("in-memory stats show 1 injection / 1 match", (notify.at(-1) ?? "").includes("inject:1 (1✓/0✗)"));

  // ------------------------------------------------ Turn 2: inject-on-miss
  await handlers.get("before_agent_start")!({ prompt: "Investigate weird error" }, ctx());
  await handlers.get("turn_start")!({}, ctx());
  await handlers.get("tool_execution_start")!({ toolName: "mystery_tool", args: {} }, ctx());
  const missResult = (await handlers.get("context")!({ messages: fakeMessages }, ctx())) as { messages: any[] } | undefined;
  const missText = missResult?.messages.at(-1)?.content?.[0]?.text ?? "";
  check("miss -> full graph injected", missText.includes("Active procedure: unknown") && missResult !== undefined);
  await runCmd("status");
  check("miss counted as miss (not match)", (notify.at(-1) ?? "").includes("inject:2 (1✓/1✗)"));

  // Finish Turn 2 with edit + bash so the task has a real trajectory.
  await handlers.get("tool_execution_start")!({ toolName: "edit", args: { path: "src/store.ts" } }, ctx());
  await handlers.get("tool_execution_end")!({ toolName: "edit", isError: false, result: { content: [{ type: "text", text: "edited" }] } }, ctx());
  await handlers.get("tool_execution_start")!({ toolName: "bash", args: { command: "npm test" } }, ctx());
  await handlers.get("tool_execution_end")!({ toolName: "bash", isError: false, result: { content: [{ type: "text", text: "PASS" }] } }, ctx());

  // ------------------------------------------------------- settle + evolve
  await handlers.get("agent_settled")!({}, ctx());
  const store3 = readStore();
  check("history recorded 1 success task", store3.history.length === 1 && store3.history[0].verdict === "success");
  check("refiner staged candidate", store3.staged !== null && store3.staged.edits.length === 1);

  // ---------------------------------------------------------------- /pg ui
  await runCmd("status");
  const statusLine = notify.at(-1) ?? "";
  check("/pg status reports staged + history", statusLine.includes("staged:yes") && statusLine.includes("history:1"));

  await runCmd("review");
  const reviewPath = join(cwd, ".pi", "procedural-graph.review.md");
  check("/pg review wrote review file", existsSync(reviewPath) && readFileSync(reviewPath).includes("add_edge"));

  await runCmd("accept");
  const store4 = readStore();
  check("/pg accept committed candidate", store4.staged === null && store4.graph.edges.length === 14);
  check("committed tasks marked evolved", store4.history.every((t: any) => t.evolved === true));
  check("stats.commits incremented", store4.stats.commits === 1);

  // ---------------------------------------------- rejection memory path
  modelRegistry.complete = async () => ({
    content: [{ type: "text", text: `[{"op":"delete_node","id":"Start"}]` }],
  });
  await runCmd("task start manual-reject-task");
  await handlers.get("tool_execution_start")!({ toolName: "read", args: {} }, ctx());
  await handlers.get("tool_execution_end")!({ toolName: "read", isError: false, result: { content: [{ type: "text", text: "x" }] } }, ctx());
  await runCmd("verdict success");
  await runCmd("evolve --force");
  const store5 = readStore();
  check("invalid proposal -> rejection memory (not committed)", store5.rejectionMemory.length === 1 && store5.staged === null);
  check("rejection stats incremented", store5.stats.rejections === 1);

  // ------------------------------------------------------------- pg_status
  const toolResult = await registry.tool!.execute("id", {}, new AbortController().signal, () => {}, ctx());
  const toolText = toolResult.content?.[0]?.text ?? "";
  check("pg_status tool returns active node + edges", toolText.includes("Active:") && toolText.includes("edges"));

  // -------------------------------------------------------------- reset
  await runCmd("reset --yes");
  const store6 = readStore();
  check("/pg reset -> skeleton, history kept", store6.graph.edges.length === 13 && store6.history.length >= 1);

  console.log(`\n${failures === 0 ? "ALL HARNESS CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  console.log(`harness dir left for inspection: ${cwd}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS CRASHED:", e);
  process.exit(1);
});