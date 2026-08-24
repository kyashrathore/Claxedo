#!/usr/bin/env bash
set -euo pipefail

NODE=/usr/local/bin/node
BUN=/home/crabbox/.bun/bin/bun
FRAMEWORK=/mnt/benchmark/framework
T3=/mnt/benchmark/t3
CLAX=/work/crabbox/cbx_1225867ef89b/Claxedo
CORPUS=/mnt/benchmark/corpus
CONFIG=/mnt/benchmark/config-solid2-web-vs-t3-v3-quick.json
OUTPUT=/mnt/benchmark/output/solid2-web-vs-t3-v3-quick-20260823
export PATH=/home/crabbox/.bun/bin:/usr/local/bin:/usr/bin:/bin

test "$($NODE --version)" = "v24.15.0"
test "$($BUN --version)" = "1.3.14"
test "$(cd "$T3" && pnpm --version)" = "11.10.0"
test "$(git -C "$FRAMEWORK" rev-parse HEAD)" = "d0d11bce442cb447db8efd6c15f7b1d686c37da2"
test "$(git -C "$T3" rev-parse HEAD)" = "22c4e40aa8818956556cffbe381ca3efbbf74327"
test "$(git -C "$CLAX" rev-parse HEAD)" = "d631aad47c16f4d33e1dc64c3dfd3c5abbe3014b"
test "$(git -C "$CLAX" status --porcelain=v1 | wc -l | tr -d ' ')" = "1256"
test "$(git -C "$CLAX" status --porcelain=v1 | sha256sum | cut -d ' ' -f1)" = "8e47480de58a8256a04508e763558dfcb124bb9696663439cca177c0c6849d6b"

test ! -e "$OUTPUT"
test -x "$FRAMEWORK/native/resource-monitor/target/release/agent-app-resource-monitor"
for file in \
  "$T3/apps/desktop/dist-electron/main.cjs" \
  "$T3/apps/desktop/dist-electron/preload.cjs" \
  "$T3/apps/desktop/dist-electron/preview-pick-preload.cjs" \
  "$T3/apps/desktop/dist-electron/preview-pip-preload.cjs" \
  "$T3/apps/server/dist/bin.mjs" \
  "$T3/apps/server/dist/client/index.html"; do
  test -s "$file"
done
test -x "$T3/native/resource-monitor/target/release/t3-resource-monitor"
test -x "$T3/apps/desktop/node_modules/electron/dist/electron"
test "$($NODE -p "require('$T3/apps/desktop/node_modules/electron/package.json').version")" = "41.5.0"

test -s "$CLAX/packages/claxedo-app/dist-local/index.local.html"
test -d "$CLAX/packages/claxedo-app/dist-local/assets"
test -s "$CLAX/packages/claxedo-desktop/resources/claxedo-server/index.js"
test -d "$CLAX/packages/claxedo-desktop/resources/claxedo-server/chunks"
test -s "$CLAX/packages/opencode/dist/node/node.js"
test -s "$CLAX/packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts"
test -s "$CLAX/packages/claxedo-app/node_modules/vite/bin/vite.js"
test -x /mnt/benchmark/playwright/chromium-1228/chrome-linux64/chrome
for package in agent-sdk-runtime claxedo-desktop claxedo-local-server claxedo-server-core claxedo-server wakes workgraph workspace-runtime; do
  test -e "$CLAX/packages/$package/node_modules/better-sqlite3/package.json"
done
test -s "$CLAX/packages/agent-event-runtime/dist/index.mjs"
test -s "$CLAX/packages/agent-sdk-runtime/dist/index.mjs"
test -s "$CLAX/packages/agent-sdk-runtime/dist/adapters.mjs"
(
  cd "$CLAX/packages/claxedo-server-core"
  $NODE --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(":memory:"); db.exec("select 1"); db.close()'
)
(
  cd "$CLAX/packages/workspace-runtime"
  $BUN -e 'import { RuntimeStore } from "./src/store.ts"; if (typeof RuntimeStore !== "function") throw new Error("RuntimeStore missing")'
)

test "$(sha256sum "$T3/apps/desktop/dist-electron/main.cjs" | cut -d ' ' -f1)" = "74e646ac34fa3f9b71436a9536503c1d82b1fde864e3bd897b82ba47ff7bf9dd"
test "$(sha256sum "$CLAX/packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts" | cut -d ' ' -f1)" = "4c8c56d47fc8198df9ec0c854071233479afeaf698888cb2740cd4fcfeb115e2"

DISPLAY=:99 xdpyinfo >/dev/null
test -S /mnt/benchmark/runtime/xdg/bus
kill -0 "$(cat /mnt/benchmark/runtime/xvfb.pid)"
kill -0 "$(cat /mnt/benchmark/runtime/dbus.pid)"
gdbus call \
  --address unix:path=/mnt/benchmark/runtime/xdg/bus \
  --dest org.freedesktop.DBus \
  --object-path /org/freedesktop/DBus \
  --method org.freedesktop.DBus.ListNames >/dev/null

test "$($NODE "$FRAMEWORK/bin/agent-app-benchmark.mjs" corpus verify --input "$CORPUS")" = \
  "8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc"
$NODE "$FRAMEWORK/bin/agent-app-benchmark.mjs" validate >/mnt/benchmark/logs/framework-registry.txt
$NODE --input-type=module - "$CONFIG" <<'NODE'
import fs from "node:fs"
import { buildComparisonSchedule, validateComparisonConfig } from "/mnt/benchmark/framework/src/comparison-run.mjs"
import { digest } from "/mnt/benchmark/framework/src/canonical-json.mjs"
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
validateComparisonConfig(config)
const actual = digest(buildComparisonSchedule(config.apps.map((app) => app.id), config.scenarioIds))
const expected = "a591aac14716d8cb3d2d8f7cce6e85c2baac0034e9cd49eb410863c4d41b9018"
if (actual !== expected) throw new Error(`schedule mismatch: ${actual}`)
console.log(actual)
NODE

(
  cd "$CLAX/packages/claxedo-app/perf-harness"
  PLAYWRIGHT_BROWSERS_PATH=/mnt/benchmark/playwright "$BUN" -e '
    import { chromium } from "playwright-core"
    const browser = await chromium.launch({ headless: true })
    const cdp = await browser.newBrowserCDPSession()
    const version = await cdp.send("Browser.getVersion")
    if (!version.product) throw new Error("missing product")
    await cdp.detach()
    await browser.close()
    console.log(version.product)
  '
)

$NODE --input-type=module - <<'NODE'
import net from "node:net"
await Promise.all([38593, 38444].map((port) => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once("error", reject)
  server.listen(port, "127.0.0.1", () => server.close(resolve))
})))
NODE

HELLO='{"protocolVersion":1,"kind":"request","correlationId":"request-0","method":"hello","params":{"frameworkVersion":1}}'
COMMON_ENV=(
  PATH=/home/crabbox/.bun/bin:/usr/local/bin:/usr/bin:/bin
  TMPDIR=/mnt/benchmark/tmp
  LANG=C.UTF-8
  LC_ALL=C.UTF-8
  DISPLAY=:99
  XDG_RUNTIME_DIR=/mnt/benchmark/runtime/xdg
  DBUS_SESSION_BUS_ADDRESS=unix:path=/mnt/benchmark/runtime/xdg/bus
  NO_AT_BRIDGE=1
)
printf '%s\n' "$HELLO" | timeout 300s env "${COMMON_ENV[@]}" T3CODE_DISABLE_AUTO_UPDATE=true \
  "$NODE" "$T3/scripts/lib/agent-app-benchmark/drivers/t3.ts" \
  > /mnt/benchmark/logs/t3-hello.json
printf '%s\n' "$HELLO" | timeout 300s env "${COMMON_ENV[@]}" \
  PLAYWRIGHT_BROWSERS_PATH=/mnt/benchmark/playwright \
  CLAXEDO_WEB_NODE="$NODE" \
  CLAXEDO_BENCHMARK_TARGET=web \
  CLAXEDO_BENCHMARK_WEB_SERVER_PORT=38593 \
  CLAXEDO_BENCHMARK_WEB_PREVIEW_PORT=38444 \
  "$BUN" "$CLAX/packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts" \
  > /mnt/benchmark/logs/clax-hello.json

$NODE --input-type=module - <<'NODE'
import fs from "node:fs"
for (const spec of [
  ["/mnt/benchmark/logs/t3-hello.json", "t3", "22c4e40aa8818956556cffbe381ca3efbbf74327", "translated", "74e646ac34fa3f9b71436a9536503c1d82b1fde864e3bd897b82ba47ff7bf9dd", "d1bc5152edf680cd7eb76f23fb5376a78b30f6acfdd85d834f5ca3ea754421f8"],
  ["/mnt/benchmark/logs/clax-hello.json", "claxedo-web", "d631aad47c16f4d33e1dc64c3dfd3c5abbe3014b", "native-opencode", "e5b527228b546a342a8eec8e9e90578178edddb95fcdfc2939fb829dce8f97f6", "c94470f70735b88f25ad1b162afb07312f737b3fbe4d0ee964bd400a55b0c7c8"],
]) {
  const [file, app, commit, mode, build, driver] = spec
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean)
  if (lines.length !== 1) throw new Error(`${app}: ${lines.length} responses`)
  const response = JSON.parse(lines[0])
  const hello = response.result
  if (!response.ok || response.method !== "hello") throw new Error(`${app}: hello failed`)
  if (hello.application.id !== app || hello.driver.sourceCommit !== commit) throw new Error(`${app}: identity mismatch`)
  if (hello.application.buildDigestSha256 !== build) throw new Error(`${app}: build mismatch ${hello.application.buildDigestSha256}`)
  if (hello.driver.digestSha256 !== driver) throw new Error(`${app}: driver mismatch ${hello.driver.digestSha256}`)
  if (!hello.materializationModes.includes(mode)) throw new Error(`${app}: materialization mismatch`)
  for (const id of ["app-start-v3", "session-switch-v3"]) if (!hello.scenarios.includes(id)) throw new Error(`${app}: missing ${id}`)
  console.log(JSON.stringify({ app, build, driver, commit, mode }))
}
NODE

! pgrep -x electron
! pgrep -x chrome
! pgrep -x chromium
echo BENCHMARK_PREFLIGHT_PASS
