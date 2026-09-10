/**
 * A/B benchmark for pi-procedural-graphs.
 *
 * Modes:
 *  - default (isolated): each task runs twice (extension OFF vs ON) in a fresh
 *    per-task project dir. Graph is skeleton-only; no cross-task learning.
 *  - BENCH_SHARED=1: each arm runs ALL tasks sequentially in ONE project dir.
 *    For ON, the graph store persists across tasks and the refiner evolves
 *    after every task (batchSize 1, verdict = the task's own test command), so
 *    we can measure whether the graph learns and whether later tasks benefit.
 *
 * Scoring: the task's verification command (exit 0 = pass). Process metrics
 * (steps, consecutive-repetition) come from the pi --mode json event stream.
 *
 * Isolation: sandboxed HOME (strips packages/extensions, pins model), fresh
 * /tmp work dir, no running-session interference. Makes real LLM calls.
 *
 * Run: npm run benchmark
 * Overrides: BENCH_MODEL, BENCH_PROVIDER, BENCH_TASKS (comma list), BENCH_SHARED=1,
 *            BENCH_WORK, PI_BIN, PG_EXT
 */
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const EXT = resolve(process.env.PG_EXT || "src/index.ts");
const PI = process.env.PI_BIN || "/opt/homebrew/bin/pi";
const MODEL = process.env.BENCH_MODEL || "antigravity/gemini-3.8-flash";
const PROVIDER = process.env.BENCH_PROVIDER || "LiteLLM";
const ROOT = process.env.BENCH_WORK || "/tmp/pg-bench";
const SHARED = process.env.BENCH_SHARED === "1";
const TASK_NAMES = (process.env.BENCH_TASKS || "sum,palindrome,fixme,fib10,greet-file,reverse,multibug,two-files,csv-sum,config-edit").split(",");
const MAX_RUN_MS = 240000;

const PROMPT =
  "Complete the task described in task.md in this directory. After implementing, run the verification command yourself to confirm it exits 0. The task is not done until that command passes.";

const TASKS = [
  {
    name: "sum",
    files: {
      "task.md": `# Task
Create \`sum.js\` that exports a function \`sum(arr)\` returning the sum of an array of numbers.

## Verify
Run: \`node -e "const s=require('./sum.js'); const r=s.sum([1,2,3,4]); if(r!==10){ console.error('got '+r); process.exit(1); } console.log('sum ok')"\`
It must print \`sum ok\` and exit 0.`,
    },
    testCmd: `node -e "const s=require('./sum.js'); const r=s.sum([1,2,3,4]); if(r!==10){ console.error('got '+r); process.exit(1); } console.log('sum ok')"`,
  },
  {
    name: "palindrome",
    files: {
      "task.md": `# Task
Create \`palindrome.js\` exporting \`isPalindrome(str)\` that returns true for palindromes (ignore case, spaces and punctuation).

## Verify
Run: \`node -e "const p=require('./palindrome.js'); const t=[['A man a plan a canal Panama',true],['hello',false],['racecar',true]]; for(const [s,e] of t){ if(p.isPalindrome(s)!==e){ console.error('fail '+s); process.exit(1); } } console.log('palindrome ok')"\`
It must print \`palindrome ok\` and exit 0.`,
    },
    testCmd: `node -e "const p=require('./palindrome.js'); const t=[['A man a plan a canal Panama',true],['hello',false],['racecar',true]]; for(const [s,e] of t){ if(p.isPalindrome(s)!==e){ console.error('fail '+s); process.exit(1); } } console.log('palindrome ok')"`,
  },
  {
    name: "fixme",
    files: {
      "fixme.js": `// BUG: the loop stops one element too early.
function countEvens(nums) {
  let count = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] % 2 === 0) count++;
  }
  return count;
}
module.exports = { countEvens };`,
      "task.md": `# Task
\`fixme.js\` has a bug: \`countEvens\` misses the last element. Fix it so the verify command passes.

## Verify
Run: \`node -e "const {countEvens}=require('./fixme.js'); const r=countEvens([2,3,4,6]); if(r!==3){ console.error('got '+r); process.exit(1); } console.log('fixme ok')"\`
It must print \`fixme ok\` and exit 0.`,
    },
    testCmd: `node -e "const {countEvens}=require('./fixme.js'); const r=countEvens([2,3,4,6]); if(r!==3){ console.error('got '+r); process.exit(1); } console.log('fixme ok')"`,
  },
  {
    name: "fib10",
    files: {
      "task.md": `# Task
Create \`fib.js\` that prints the first 10 Fibonacci numbers (1,1,2,3,5,8,13,21,34,55), one per line, and nothing else.

## Verify
Run: \`node -e "const {execFileSync}=require('child_process'); const out=execFileSync('node',['fib.js']).toString().trim().split('\\n').map(Number); const want=[1,1,2,3,5,8,13,21,34,55]; if(JSON.stringify(out)!==JSON.stringify(want)){ console.error('got '+out); process.exit(1); } console.log('fib10 ok')"\`
It must print \`fib10 ok\` and exit 0.`,
    },
    testCmd: `node -e "const {execFileSync}=require('child_process'); const out=execFileSync('node',['fib.js']).toString().trim().split('\\n').map(Number); const want=[1,1,2,3,5,8,13,21,34,55]; if(JSON.stringify(out)!==JSON.stringify(want)){ console.error('got '+out); process.exit(1); } console.log('fib10 ok')"`,
  },
  {
    name: "greet-file",
    files: {
      "task.md": `# Task
Create \`greet.txt\` whose contents are exactly \`Hello, benchmark!\` (no trailing newline).

## Verify
Run: \`node -e "const fs=require('fs'); const c=fs.readFileSync('greet.txt','utf8'); if(c!=='Hello, benchmark!'){ console.error('got '+JSON.stringify(c)); process.exit(1); } console.log('greet ok')"\`
It must print \`greet ok\` and exit 0.`,
    },
    testCmd: `node -e "const fs=require('fs'); const c=fs.readFileSync('greet.txt','utf8'); if(c!=='Hello, benchmark!'){ console.error('got '+JSON.stringify(c)); process.exit(1); } console.log('greet ok')"`,
  },
  {
    name: "reverse",
    files: {
      "task.md": `# Task
Create \`reverse.js\` exporting \`reverse(str)\` that reverses a string (e.g. \`'abc'\` -> \`'cba'\`).

## Verify
Run: \`node -e "const {reverse}=require('./reverse.js'); const r=reverse('hello'); if(r!=='olleh'){ console.error('got '+r); process.exit(1); } console.log('reverse ok')"\`
It must print \`reverse ok\` and exit 0.`,
    },
    testCmd: `node -e "const {reverse}=require('./reverse.js'); const r=reverse('hello'); if(r!=='olleh'){ console.error('got '+r); process.exit(1); } console.log('reverse ok')"`,
  },
  {
    name: "multibug",
    files: {
      "multibug.js": `// Three bugs:
// 1. sum() only adds even numbers.
// 2. max() returns -1 for an empty array instead of undefined.
// 3. product() starts at 0 so it always returns 0.
function sum(nums) { let t = 0; for (const n of nums) { if (n % 2 === 0) t += n; } return t; }
function max(nums) { let m = -1; for (const n of nums) m = Math.max(m, n); return m; }
function product(nums) { let p = 0; for (const n of nums) p *= n; return p; }
module.exports = { sum, max, product };`,
      "task.md": `# Task
\`multibug.js\` has three bugs. Fix all three so the verify command passes.

## Verify
Run: \`node -e "const m=require('./multibug.js'); if(m.sum([1,2,3,4])!==10){console.error('sum');process.exit(1);} if(m.max([])!==undefined){console.error('max');process.exit(1);} if(m.product([2,3,4])!==24){console.error('product');process.exit(1);} console.log('multibug ok')"\`
It must print \`multibug ok\` and exit 0.`,
    },
    testCmd: `node -e "const m=require('./multibug.js'); if(m.sum([1,2,3,4])!==10){console.error('sum');process.exit(1);} if(m.max([])!==undefined){console.error('max');process.exit(1);} if(m.product([2,3,4])!==24){console.error('product');process.exit(1);} console.log('multibug ok')"`,
  },
  {
    name: "two-files",
    files: {
      "task.md": `# Task
Create two files:
- \`math.js\` exporting \`add(a,b)\` and \`mul(a,b)\`.
- \`main.js\` that requires \`./math.js\` and prints the result of \`add(mul(2,3), 4)\` (which is 10) followed by a newline, and nothing else.

## Verify
Run: \`node -e "const {execFileSync}=require('child_process'); const out=execFileSync('node',['main.js']).toString().trim(); if(out!=='10'){ console.error('got '+out); process.exit(1); } console.log('two-files ok')"\`
It must print \`two-files ok\` and exit 0.`,
    },
    testCmd: `node -e "const {execFileSync}=require('child_process'); const out=execFileSync('node',['main.js']).toString().trim(); if(out!=='10'){ console.error('got '+out); process.exit(1); } console.log('two-files ok')"`,
  },
  {
    name: "csv-sum",
    files: {
      "data.csv": "name,amount\nalice,10\nbob,25\ncarol,5\n",
      "task.md": `# Task
Create \`total.js\` that reads \`data.csv\` (columns: name,amount) and prints the total amount (which is 40) followed by a newline, and nothing else.

## Verify
Run: \`node -e "const {execFileSync}=require('child_process'); const out=execFileSync('node',['total.js']).toString().trim(); if(out!=='40'){ console.error('got '+out); process.exit(1); } console.log('csv-sum ok')"\`
It must print \`csv-sum ok\` and exit 0.`,
    },
    testCmd: `node -e "const {execFileSync}=require('child_process'); const out=execFileSync('node',['total.js']).toString().trim(); if(out!=='40'){ console.error('got '+out); process.exit(1); } console.log('csv-sum ok')"`,
  },
  {
    name: "config-edit",
    files: {
      "config.json": "{\n  \"server\": {\n    \"host\": \"localhost\",\n    \"port\": 3000\n  }\n}\n",
      "task.md": `# Task
Edit \`config.json\` so the server port is 8080 instead of 3000. Keep the JSON valid.

## Verify
Run: \`node -e "const c=require('./config.json'); if(c.server.port!==8080){ console.error('port '+c.server.port); process.exit(1); } console.log('config-edit ok')"\`
It must print \`config-edit ok\` and exit 0.`,
    },
    testCmd: `node -e "const c=require('./config.json'); if(c.server.port!==8080){ console.error('port '+c.server.port); process.exit(1); } console.log('config-edit ok')"`,
  },
];

function setupHome(homeDir) {
  mkdirSync(join(homeDir, ".pi/agent"), { recursive: true });
  const s = JSON.parse(readFileSync(join(process.env.HOME, ".pi/agent/settings.json"), "utf8"));
  delete s.packages; delete s.extensions;
  s.defaultProvider = PROVIDER;
  s.defaultModel = MODEL;
  writeFileSync(join(homeDir, ".pi/agent/settings.json"), JSON.stringify(s, null, 2));
  const auth = join(process.env.HOME, ".pi/agent/auth.json");
  const destAuth = join(homeDir, ".pi/agent/auth.json");
  try { rmSync(destAuth, { force: true }); } catch {}
  try { symlinkSync(auth, destAuth); } catch { cpSync(auth, destAuth); }
  cpSync(join(process.env.HOME, ".pi/agent/models.json"), join(homeDir, ".pi/agent/models.json"));
}

function runPi(taskDir, homeDir, args) {
  const res = spawnSync(PI, args, {
    cwd: taskDir, env: { ...process.env, HOME: homeDir },
    timeout: MAX_RUN_MS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return { timedOut: res.status === null, status: res.status, out: res.stdout || "", err: res.stderr || "" };
}

function parseRun(jsonl) {
  const tools = [];
  let stepCount = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "tool_execution_start") { tools.push(e.toolName); stepCount++; }
    } catch {}
  }
  let repetition = 0;
  for (let i = 1; i < tools.length; i++) if (tools[i] === tools[i - 1]) repetition++;
  return { tools, stepCount, repetition };
}

function writeConfig(dir, testCmd) {
  writeFileSync(
    join(dir, ".pi", "procedural-graph.config.json"),
    JSON.stringify({
      enabled: true,
      guidance: { mode: "inject", hops: 2, window: 3, injectOnMiss: true, maxGraphNodesForFullInjection: 20 },
      evolution: { batchSize: 1, minBatchForForce: 1, autoApprove: process.env.BENCH_AUTOAPPROVE === "1", validationCommand: null, refinerMaxTokens: 2000, maxTrajectoryTokens: 8000, maxRejectionMemories: 10 },
      verdict: { command: testCmd, autoFailOnError: false },
    }, null, 2),
  );
}

function extStats(dir) {
  if (!existsSync(join(dir, ".pi", "procedural-graph.json"))) return null;
  const st = JSON.parse(readFileSync(join(dir, ".pi", "procedural-graph.json"), "utf8"));
  return { injections: st.stats.injections, matches: st.stats.matches, evolutions: st.stats.evolutions, edges: st.graph.edges.length };
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "tasks"), { recursive: true });
const homeCtrl = join(ROOT, "home-ctrl");
const homeExt = join(ROOT, "home-ext");
setupHome(homeCtrl);
setupHome(homeExt);

const results = [];
const extCurve = []; // shared ON: cumulative graph size per task

function runOne({ dir, home, arm, task, seq }) {
  const args = ["--mode", "json"];
  if (arm === "on") args.push("-e", EXT);
  args.push(PROMPT);
  const t0 = Date.now();
  const r = runPi(dir, home, args);
  const ms = Date.now() - t0;
  writeFileSync(join(dir, "run.jsonl"), r.out);
  writeFileSync(join(dir, "run.err"), r.err);
  const score = spawnSync("bash", ["-c", task.testCmd], { cwd: dir, encoding: "utf8", timeout: 30000 });
  const pass = score.status === 0;
  const meta = parseRun(r.out);
  const ext = arm === "on" ? extStats(dir) : null;
  if (arm === "on") extCurve.push({ task: task.name, seq, edges: ext?.edges ?? 13, injections: ext?.injections ?? 0 });
  results.push({ task: task.name, arm, seq, pass, steps: meta.stepCount, repetition: meta.repetition, timedOut: r.timedOut, ms, tools: meta.tools.join(","), ext });
  console.log(`${arm === "on" ? "ON " : "OFF"} ${String(seq).padStart(2)} ${task.name.padEnd(10)} pass=${pass ? "yes" : "NO "} steps=${String(meta.stepCount).padStart(2)} rep=${meta.repetition} ${(ms / 1000).toFixed(0)}s${ext ? " " + JSON.stringify(ext) : ""} tools=${meta.tools.join(",")}`);
}

if (SHARED) {
  console.log(`== shared mode: ${TASK_NAMES.length} tasks, sequential per arm, persistent graph (ON) ==`);
  for (const arm of ["off", "on"]) {
    const dir = join(ROOT, "tasks", `shared-${arm}`);
    mkdirSync(join(dir, ".pi"), { recursive: true });
    TASK_NAMES.forEach((name, i) => {
      const task = TASKS.find((t) => t.name === name);
      if (!task) { console.error(`unknown task: ${name}`); return; }
      for (const [f, c] of Object.entries(task.files)) writeFileSync(join(dir, f), c);
      if (arm === "on") writeConfig(dir, task.testCmd);
      runOne({ dir, home: arm === "on" ? homeExt : homeCtrl, arm, task, seq: i + 1 });
    });
  }
} else {
  console.log(`== isolated mode: ${TASK_NAMES.length} tasks x (off/on) ==`);
  for (const name of TASK_NAMES) {
    const task = TASKS.find((t) => t.name === name);
    if (!task) { console.error(`unknown task: ${name}`); continue; }
    for (const arm of ["off", "on"]) {
      const dir = join(ROOT, "tasks", `${name}-${arm}`);
      mkdirSync(join(dir, ".pi"), { recursive: true });
      for (const [f, c] of Object.entries(task.files)) writeFileSync(join(dir, f), c);
      if (arm === "on") writeConfig(dir, task.testCmd);
      runOne({ dir, home: arm === "on" ? homeExt : homeCtrl, arm, task, seq: 0 });
    }
  }
}

writeFileSync(join(ROOT, "results.json"), JSON.stringify(results, null, 2));

const mean = (arm, f) => {
  const a = results.filter((r) => r.arm === arm);
  return a.length ? a.reduce((s, r) => s + f(r), 0) / a.length : 0;
};
console.log("\n=== SUMMARY ===");
for (const arm of ["off", "on"]) {
  const a = results.filter((r) => r.arm === arm);
  const passRate = a.length ? a.filter((r) => r.pass).length / a.length : 0;
  console.log(
    `${arm === "on" ? "Extension ON " : "Control OFF "} n=${a.length} passRate=${(passRate * 100).toFixed(0)}% meanSteps=${mean(arm, (r) => r.steps).toFixed(1)} meanRep=${mean(arm, (r) => r.repetition).toFixed(2)}`,
  );
}
if (SHARED) {
  const on = results.filter((r) => r.arm === "on").sort((a, b) => a.seq - b.seq);
  const half = Math.floor(on.length / 2);
  if (half >= 1) {
    const early = on.slice(0, half), late = on.slice(half);
    const rate = (a) => (a.length ? a.filter((r) => r.pass).length / a.length : 0);
    const avg = (a, f) => (a.length ? a.reduce((s, r) => s + f(r), 0) / a.length : 0);
    console.log(`\n=== learning trend (ON, shared) ==`);
    console.log(`tasks ${early.length ? `1-${half}` : ""} pass=${(rate(early) * 100).toFixed(0)}% steps=${avg(early, (r) => r.steps).toFixed(1)} rep=${avg(early, (r) => r.repetition).toFixed(2)}`);
    console.log(`tasks ${half + 1}-${on.length} pass=${(rate(late) * 100).toFixed(0)}% steps=${avg(late, (r) => r.steps).toFixed(1)} rep=${avg(late, (r) => r.repetition).toFixed(2)}`);
    console.log(`graph growth: ${extCurve.map((e) => `${e.task}=${e.edges}`).join(", ")}`);
  }
}
console.log(`\nresults: ${join(ROOT, "results.json")}`);