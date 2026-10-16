#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { asWorkerRecord } from "./src/worker-json"

// Drives a deployed sandbox Worker through its own control routes with a
// stand-in runtime command, so a snapshot, a stop and a restore run exactly as
// a workspace's would, on the real image, with no workspace or control plane.

const { values } = parseArgs({ options: { url: { type: "string" }, "fill-mb": { type: "string", default: "256" } } })
const base = values.url?.replace(/\/+$/, "")
const token = process.env.SANDBOX_WORKER_API_TOKEN
const fillMb = Number(values["fill-mb"])
if (!base || !token || !Number.isSafeInteger(fillMb) || fillMb < 0) {
  console.error("usage: SANDBOX_WORKER_API_TOKEN=… bun measure-snapshots.ts --url https://<worker>.workers.dev [--fill-mb 256]")
  process.exit(2)
}

const PORT = 2593
const run = `measure-${Date.now().toString(36)}`
const sandboxId = `claxedo-${run}`
const serve = `exec node -e 'require("http").createServer((q, s) => s.end("ok")).listen(${PORT})'`
const fail = (what: string) => `{ echo "workspace_runtime_boot_failed: ${what}" >&2; exit 1; }`
const prepare = [
  `mkdir -p /workspace && printf %s ${run} > /workspace/measure.txt`,
  `head -c ${fillMb * 1024 * 1024} /dev/urandom > /workspace/measure.bin && sha256sum /workspace/measure.bin | cut -d' ' -f1 > /workspace/measure.sha256`,
  "npm install -g --no-audit --no-fund cowsay@1.6.0 >/dev/null",
  "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends sl >/dev/null",
].join(" && ")
const verify = [
  `[ "$(cat /workspace/measure.txt)" = ${run} ] || ${fail("the workspace file is missing")}`,
  `[ "$(sha256sum /workspace/measure.bin | cut -d' ' -f1)" = "$(cat /workspace/measure.sha256)" ] || ${fail("the workspace data changed")}`,
  `command -v cowsay >/dev/null || ${fail("the global npm package is missing")}`,
  `[ -x /usr/games/sl ] || ${fail("the apt package is missing")}`,
].join(" && ")

async function call(action: string, body: Record<string, unknown>, method = "POST") {
  const startedAt = performance.now()
  const response = await fetch(`${base}/sandbox/${sandboxId}${action ? `/${action}` : ""}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  })
  const data = asWorkerRecord(await response.json().catch(() => undefined)) ?? {}
  return { status: response.status, data, ms: Math.round(performance.now() - startedAt) }
}

const PREPARING = "workspace-runtime did not become ready"
const ENSURE_DEADLINE_MS = 10 * 60_000

/** Polls ensure-runtime through its one retryable answer until the runtime answers, and reports the whole wait. */
async function ensure(command: string, restore?: string) {
  const startedAt = performance.now()
  for (;;) {
    const answer = await call("ensure-runtime", {
      command,
      env: {},
      port: PORT,
      labels: { app: "claxedo-measure", workspaceId: run, epoch: "1" },
      ...(restore ? { restore: { snapshotId: restore } } : {}),
    })
    const ms = Math.round(performance.now() - startedAt)
    if (answer.status !== 503 || answer.data.error !== PREPARING || ms > ENSURE_DEADLINE_MS) return { ...answer, ms }
  }
}

const timings: Record<string, unknown> = { sandboxId, fillMb }
try {
  const cold = await ensure(`${prepare} && ${serve}`)
  if (cold.status !== 200) throw new Error(`cold ensure answered ${cold.status}: ${String(cold.data.error)}`)
  timings.coldStartAndPrepareMs = cold.ms
  const snapshot = await call("snapshot", {})
  if (snapshot.status !== 200) throw new Error(`snapshot answered ${snapshot.status}: ${String(snapshot.data.error)}`)
  Object.assign(timings, { snapshotMs: snapshot.ms, snapshotBytes: snapshot.data.sizeBytes })
  const snapshotId = String(snapshot.data.snapshotId)
  timings.stopMs = (await call("stop", { epoch: 1 })).ms
  const restored = await ensure(`${verify} && ${serve}`, snapshotId)
  timings.restore = { status: restored.status, ms: restored.ms, error: restored.data.error }
  const missing = await ensure(serve, "00000000-0000-0000-0000-000000000000")
  timings.missingSnapshot = { status: missing.status, snapshotMissing: missing.data.snapshotMissing, error: missing.data.error }
  if (restored.status !== 200 || missing.status !== 410) process.exitCode = 1
} catch (error) {
  timings.failure = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  timings.destroyStatus = (await call("", {}, "DELETE")).status
  console.log(JSON.stringify(timings, null, 2))
}
