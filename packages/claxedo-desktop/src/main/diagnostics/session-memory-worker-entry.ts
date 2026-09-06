import { createInterface } from "node:readline"
import { createRequire } from "node:module"

import { readArray, readString, readUnknown } from "../../shared/json-read"
import { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import { lowerDiagnosticsWorkerPriority } from "./process-metrics-worker"
import {
  scanSessionMemoryStores,
  type SessionMemoryDatabase,
  type SessionMemoryScanPaths,
} from "./session-memory-scan"

// Named on the binding rather than asserted: `require` answers `any`, so the
// declaration IS the contract for the slice of better-sqlite3 this worker uses.
const Database: new (path: string, options: { readonly: boolean; fileMustExist: boolean }) => SessionMemoryDatabase =
  createRequire(import.meta.url)("better-sqlite3")

lowerDiagnosticsWorkerPriority()
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

lines.once("line", (line) => {
  void run(line).finally(() => lines.close())
})

async function run(line: string) {
  try {
    const request: unknown = JSON.parse(line)
    const warmSessions = LocalDiagnostics.WarmSessionMemory.array().max(512).parse(readUnknown(request, "warmSessions"))
    const paths = pathsInput(readUnknown(request, "paths"))
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
  const databases = readArray(value, "databases")
  if (!databases) throw new Error("invalid scan paths")
  return {
    databases: databases.flatMap((item) => {
      const path = readString(item, "path")
      const profile = readString(item, "profile")
      return path !== undefined && profile !== undefined ? [{ path, profile }] : []
    }),
  }
}
