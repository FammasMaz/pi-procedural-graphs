/**
 * A/B benchmark for pi-procedural-graphs.
 *
 * Runs a small verifiable task corpus twice per task: control (extension OFF)
 * vs extension ON (inject mode + auto-verdict via the task's own test command,
 * so the refiner also evolves per task). Scores each run with the task's
 * verification command (exit 0 = pass) and extracts process metrics from the
 * pi --mode json event stream.
 *
 * Isolation: sandboxed HOME (strips packages/extensions, pins model), fresh
 * /tmp work dir, no running-session interference. Makes real LLM calls.
 *
 * Run: BENCH_MODEL=antigravity/gemini-3.8-flash npm run benchmark
 * Overrides: BENCH_MODEL, BENCH_PROVIDER, BENCH_TASKS (comma list), BENCH_WORK, PI_BIN, PG_EXT
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
const TASK_NAMES = (process.env.BENCH_TASKS || "sum,palindrome,fixme,fib10,greet-file,reverse").split(",");
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

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "tasks"), { recursive: true });
const homeCtrl = join(ROOT, "home-ctrl");
const homeExt = join(ROOT, "home-ext");
setupHome(homeCtrl);
setupHome(homeExt);

const results = [];
for (const name of TASK_NAMES) {
  const task = TASKS.find((t) => t.name === name);
  if (!task) { console.error(`unknown task: ${name}`); continue; }
  for (const arm of ["off", "on"]) {
    const dir = join(ROOT, "tasks", `${name}-${arm}`);
    mkdirSync(join(dir, ".pi"), { recursive: true });
    for (const [f, c] of Object.entries(task.files)) writeFileSync(join(dir, f), c);
    if (arm === "on") {
      writeFileSync(
        join(dir, ".pi", "procedural-graph.config.json"),
        JSON.stringify({
          enabled: true,
          guidance: { mode: "inject", hops: 2, window: 3, injectOnMiss: true, maxGraphNodesForFullInjection: 20 },
          evolution: { batchSize: 1, minBatchForForce: 1, autoApprove: false, validationCommand: null, refinerMaxTokens: 2000, maxTrajectoryTokens: 8000, maxRejectionMemories: 10 },
          verdict: { command: task.testCmd, autoFailOnError: false },
        }, null, 2),
      );
    }
    const args = ["--mode", "json"];
    if (arm === "on") args.push("-e", EXT);
    args.push(PROMPT);
    const t0 = Date.now();
    const r = runPi(dir, arm === "on" ? homeExt : homeCtrl, args);
    const ms = Date.now() - t0;
    writeFileSync(join(dir, "run.jsonl"), r.out);
    writeFileSync(join(dir, "run.err"), r.err);

    const score = spawnSync("bash", ["-c", task.testCmd], { cwd: dir, encoding: "utf8", timeout: 30000 });
    const pass = score.status === 0;
    const meta = parseRun(r.out);
    let ext = null;
    if (arm === "on" && existsSync(join(dir, ".pi", "procedural-graph.json"))) {
      const st = JSON.parse(readFileSync(join(dir, ".pi", "procedural-graph.json"), "utf8"));
      ext = { injections: st.stats.injections, matches: st.stats.matches, evolutions: st.stats.evolutions, edges: st.graph.edges.length };
    }
    results.push({ task: name, arm, pass, steps: meta.stepCount, repetition: meta.repetition, timedOut: r.timedOut, ms, tools: meta.tools.join(","), ext });
    const tag = arm === "on" ? "ON " : "OFF";
    console.log(`${tag} ${name.padEnd(10)} pass=${pass ? "yes" : "NO "} steps=${String(meta.stepCount).padStart(2)} rep=${meta.repetition} ${(ms / 1000).toFixed(0)}s${ext ? " " + JSON.stringify(ext) : ""} tools=${meta.tools.join(",")}`);
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
console.log(`\nresults: ${join(ROOT, "results.json")}`);