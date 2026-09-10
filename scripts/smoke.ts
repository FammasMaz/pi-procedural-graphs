/**
 * Pure-logic smoke test for the graph/evolution core. Exercises NO pi APIs —
 * safe to run anytime, even with pi sessions open: `npm run smoke`.
 * This only touches in-memory structures and /tmp files.
 */
import { createSkeletonGraph, applyEdits, localize, neighborhood, validateGraph, createEmptyStore } from "../src/graph";
import { parseEdits } from "../src/evolution";

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// 1. Skeleton is structurally valid.
const g = createSkeletonGraph("test");
check("skeleton valid", validateGraph(g).length === 0);
check("skeleton has Start", g.nodes.some((n) => n.id === "Start"));
check("skeleton has edges", g.edges.length > 0);

// 2. Localization.
check("localize tool:bash", localize(g, "bash") === "tool:bash");
check("localize exact id", localize(g, "tool:read") === "tool:read");
check("localize unknown -> null", localize(g, "not_a_tool") === null);

// 3. Neighborhood: 1-hop from tool:edit reaches tool:bash (and 2-hop reaches state via if_failed? edit -> bash -> read/needs_verification).
const h1 = neighborhood(g, "tool:edit", 1);
check("edit 1-hop contains bash", [...h1.edges].some((e) => e.target === "tool:bash"));
const h2 = neighborhood(g, "tool:edit", 2);
check("edit 2-hop reaches state:needs_verification via bash", [...h2.nodeIds].includes("state:needs_verification"));

// 4. Start localization + neighborhood.
const hStart = neighborhood(g, "Start", 1);
check("Start 1-hop has 4 outgoing", hStart.edges.length === 4);

// 5. Edits: add_node + add_edge + revise_edge + delete_edge + delete_node.
const edits: Parameters<typeof applyEdits>[1] = [
  { op: "add_node", id: "step:check_tests", kind: "step", label: "Check tests" },
  { op: "add_edge", source: "tool:edit", relation: "leads_to", target: "step:check_tests", attrs: { guidance: "Run the affected test file" } },
  { op: "revise_edge", source: "tool:edit", relation: "leads_to", target: "tool:bash", attrs: { guidance: "Run tests AND lint" } },
  { op: "delete_edge", source: "Start", relation: "leads_to", target: "tool:find" },
  { op: "delete_node", id: "tool:find" },
];
const applied = applyEdits(g, edits);
check("edits apply cleanly", applied.ok);
if (applied.ok) {
  check("add_edge created endpoint", applied.graph.nodes.some((n) => n.id === "step:check_tests"));
  check("revise applied", applied.graph.edges.find((e) => e.source === "tool:edit" && e.target === "tool:bash")?.attrs.guidance === "Run tests AND lint");
  check("delete_node cascaded incident edges", !applied.graph.edges.some((e) => e.source === "tool:find" || e.target === "tool:find"));
  check("delete_edge removed Start->find", !applied.graph.edges.some((e) => e.source === "Start" && e.target === "tool:find"));
}

// 6. Invalid edits are rejected.
const bad = applyEdits(g, [{ op: "delete_node", id: "Start" }]);
check("Start delete refused", !bad.ok);
const bad2 = applyEdits(g, [{ op: "delete_edge", source: "nope", relation: "leads_to", target: "tool:bash" }]);
check("missing edge delete refused", !bad2.ok);

// 7. Edit parsing from refiner-style JSON output.
const parsed = parseEdits('Here you go:\n```json\n[{"op":"add_node","id":"step:x","kind":"step"},{"op":"delete_node","id":"tool:find"}]\n```');
check("parseEdits extracts array", parsed.length === 2);
check("parseEdits filters junk", parseEdits("no edits here").length === 0);

// 8. Store round-trip via /tmp.
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "pg-smoke-"));
const file = join(dir, "store.json");
const store = createEmptyStore(g);
store.history.push({
  id: "t1",
  query: "test task",
  verdict: "success",
  steps: [{ tool: "bash", args: "npm test", ok: true, obs: "pass" }],
  startedAt: Date.now(),
  endedAt: Date.now(),
  evolved: false,
});
writeFileSync(file, JSON.stringify(store));
const back = JSON.parse(readFileSync(file, "utf8")) as typeof store;
check("store round-trip", back.history.length === 1 && back.graph.nodes.length === g.nodes.length);
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);