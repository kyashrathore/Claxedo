import { createInterface } from "node:readline"

import { readArray, readNumber, readUnknown } from "../../shared/json-read"
import { validPid } from "./process-identity"
import { isProcessTreeEntry, lowerDiagnosticsWorkerPriority } from "./process-metrics-worker"
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
  let request: unknown
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const id = readNumber(request, "id")
  if (id === undefined || !Number.isInteger(id)) return
  try {
    const value = await dispatch(request)
    process.stdout.write(`${JSON.stringify({ id, ok: true, value })}\n`)
  } catch {
    process.stdout.write(`${JSON.stringify({ id, ok: false })}\n`)
  }
}

function dispatch(request: unknown): Promise<unknown> | void {
  const method = readUnknown(request, "method")
  if (method === "reconcile") {
    const rootPids = readArray(request, "rootPids")
    if (rootPids) return worker.reconcile(rootPids.filter(validPid))
  }
  if (method === "sample") {
    const entries = readArray(request, "entries")
    const at = readNumber(request, "at")
    if (entries && at !== undefined) return worker.sample(entries.filter(isProcessTreeEntry), at)
  }
  if (method === "probeCreation") {
    const pid = readNumber(request, "pid")
    if (validPid(pid)) return worker.probeCreation(pid)
  }
  if (method === "clear") return worker.clear()
  return Promise.reject(new Error("invalid diagnostics worker request"))
}
