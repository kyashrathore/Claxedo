import { createInterface } from "node:readline"

import { validPid } from "./process-identity"
import { lowerDiagnosticsWorkerPriority } from "./process-metrics-worker"
import { createPosixProcessMetricsWorker } from "./process-metrics-worker-runtime"

const platform = process.env.CLAXEDO_DIAGNOSTICS_WORKER_PLATFORM
if (platform !== "darwin" && platform !== "linux") process.exit(2)

lowerDiagnosticsWorkerPriority()
const worker = createPosixProcessMetricsWorker({
  platform,
  ...(process.env.CLAXEDO_DIAGNOSTICS_MEMORY_HELPER
    ? { memoryHelperPath: process.env.CLAXEDO_DIAGNOSTICS_MEMORY_HELPER }
    : {}),
})
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

lines.on("line", (line) => {
  void handle(line)
})
lines.once("close", () => worker.dispose())

async function handle(line: string) {
  let request: Record<string, unknown>
  try {
    request = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (!Number.isInteger(request.id)) return
  try {
    const value = await dispatch(request)
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, value })}\n`)
  } catch {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false })}\n`)
  }
}

function dispatch(request: Record<string, unknown>) {
  if (request.method === "reconcile" && Array.isArray(request.rootPids)) {
    return worker.reconcile(request.rootPids.filter(validPid))
  }
  if (request.method === "sample" && Array.isArray(request.entries) && typeof request.at === "number") {
    return worker.sample(request.entries.filter(validEntry), request.at)
  }
  if (request.method === "probeCreation" && validPid(request.pid)) {
    return worker.probeCreation(request.pid)
  }
  if (request.method === "clear") return worker.clear()
  return Promise.reject(new Error("invalid diagnostics worker request"))
}

function validEntry(value: unknown): value is { pid: number; ppid: number; rootPid: number } {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return (
    validPid(entry.pid) &&
    typeof entry.ppid === "number" &&
    Number.isInteger(entry.ppid) &&
    entry.ppid >= 0 &&
    validPid(entry.rootPid)
  )
}
