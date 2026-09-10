#!/usr/bin/env bash
#
# Disposable REAL-MODEL validation for pi-procedural-graphs.
#
# Runs pi in --mode json (non-interactive) inside a fresh /tmp project with a
# sandboxed HOME so your global extension config (and any broken packages) are
# NOT loaded, and so running pi sessions are never touched.
#
# The model is pinned to the user's working tunnel model (Freebuff via LiteLLM).
# Override with:  DISPOSABLE_MODEL="provider/model" npm run disposable-test
#
# Exit 0 = all smoke assertions on the resulting store pass.
set -euo pipefail

EXT="${PG_EXT:-/Users/fammasmaz/Downloads/pi-procedural-graphs/src/index.ts}"
PI_BIN="${PI_BIN:-/opt/homebrew/bin/pi}"
WORK="${DISPOSABLE_WORK:-/tmp/pg-disposable}"
HOME_DIR="${WORK}/home"
PROJ="${WORK}/proj"
MODEL="${DISPOSABLE_MODEL:-freebuff/deepseek/deepseek-v4-flash}"
PROVIDER="${DISPOSABLE_PROVIDER:-LiteLLM}"
PROMPT="${DISPOSABLE_PROMPT:-Create a file hello.txt containing exactly 'hello procedural graph'. Then run ls to verify it exists. Finally, call the pg_status tool and report what it says about the active procedure.}"

echo "==> cleaning $WORK"
rm -rf "$WORK"
mkdir -p "$HOME_DIR/.pi/agent" "$PROJ/.pi"

echo "==> sandboxed settings (no packages/extensions, pinned model)"
HOME_DIR="$HOME_DIR" PROVIDER="$PROVIDER" MODEL="$MODEL" node -e '
const fs = require("fs");
const real = process.env.HOME + "/.pi/agent/settings.json";
const s = JSON.parse(fs.readFileSync(real, "utf8"));
delete s.packages; delete s.extensions;
s.defaultProvider = process.env.PROVIDER;
s.defaultModel = process.env.MODEL;
fs.writeFileSync(process.env.HOME_DIR + "/.pi/agent/settings.json", JSON.stringify(s, null, 2));
'

echo "==> symlink auth + copy model catalog"
ln -sf "$HOME/.pi/agent/auth.json" "$HOME_DIR/.pi/agent/auth.json"
cp "$HOME/.pi/agent/models.json" "$HOME_DIR/.pi/agent/models.json"

echo "==> per-project config: 1-task batches, inject mode, verdict from exit code"
cat > "$PROJ/.pi/procedural-graph.config.json" <<EOF
{
  "enabled": true,
  "guidance": { "mode": "inject", "hops": 2, "window": 3, "injectOnMiss": true, "maxGraphNodesForFullInjection": 20 },
  "evolution": { "batchSize": 1, "minBatchForForce": 1, "autoApprove": false, "validationCommand": null, "refinerMaxTokens": 2000, "maxTrajectoryTokens": 8000, "maxRejectionMemories": 10 },
  "verdict": { "command": "exit 0", "autoFailOnError": false }
}
EOF

echo "==> running pi (json mode, real model) — this makes real LLM calls"
(
  cd "$PROJ"
  HOME="$HOME_DIR" timeout 300 "$PI_BIN" --mode json -e "$EXT" "$PROMPT" > run.jsonl 2> run.err
)
echo "pi exit: $?"

echo "==> assertions"
fail=0
check() { if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }

STORE="$PROJ/.pi/procedural-graph.json"
[ -f "$STORE" ]
check "store file created" $?
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));' "$STORE"
check "store parses as JSON" $?

# The refiner is stochastic: a round may legitimately end staged, or with
# "no edits" (batch marked evolved), or in rejection memory. All are valid
# terminal outcomes of a run evolve round (evolutions >= 1).
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const out = {
  injections: s.stats.injections,
  matches: s.stats.matches,
  history: s.history.length,
  verdict: s.history[0]?.verdict,
  evolved: s.history[0]?.evolved,
  evolutions: s.stats.evolutions,
  stagedEdits: s.staged?.edits?.length ?? 0,
  edges: s.graph.edges.length,
  rejectionMemory: s.rejectionMemory.length,
};
console.log(JSON.stringify(out));
process.exit(
  out.injections >= 1 && out.history >= 1 && out.verdict === "success" && out.evolutions >= 1 ? 0 : 1
);
' "$STORE"
check "context injected, task succeeded, evolve round ran" $?

echo "==> tool calls observed:"
grep -o '"type":"tool_execution_start"' "$PROJ/run.jsonl" | wc -l | xargs echo "  tool executions:"
echo "==> done. artifacts in $WORK (store: $STORE)"
exit $fail