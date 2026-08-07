import { createInterface } from "node:readline"
import { createRequire } from "node:module"
import { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import { lowerDiagnosticsWorkerPriority } from "./process-metrics-worker"
import {
  scanSessionMemoryStores,
  type SessionMemoryDatabase,
  type SessionMemoryScanPaths,
} from "./session-memory-scan"

const Database = createRequire(import.meta.url)("better-sqlite3") as new (
  path: string,
  options: { readonly: boolean; fileMustExist: boolean },
) => SessionMemoryDatabase

lowerDiagnosticsWorkerPriority()
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

lines.once("line", (line) => {
  void run(line).finally(() => lines.close())
})

async function run(line: string) {
  try {
    const request = JSON.parse(line) as { paths?: unknown; warmSessions?: unknown }
    const warmSessions = LocalDiagnostics.WarmSessionMemory.array().max(512).parse(request.warmSessions)
    const paths = pathsInput(request.paths)
    const result = await scanSessionMemoryStores({
      paths,
      warmSessions,
      openDatabase: (path) => new Database(path, { readonly: true, fileMustExist: true }),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false })}\n`)
  }
}

function pathsInput(value: unknown): SessionMemoryScanPaths {
  if (!value || typeof value !== "object") throw new Error("invalid scan paths")
  const input = value as Partial<SessionMemoryScanPaths>
  if (!Array.isArray(input.databases)) {
    throw new Error("invalid scan paths")
  }
  return {
    databases: input.databases.flatMap((item) =>
      item && typeof item.path === "string" && typeof item.profile === "string" ? [item] : []),
  }
}
