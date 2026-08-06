import { spawn } from "node:child_process"
import { join } from "node:path"
import { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import type { SessionMemoryScanPaths } from "./session-memory-scan"

export function createSessionMemoryScanner(options: {
  paths: SessionMemoryScanPaths
  workerPath?: string
  timeoutMs?: number
}) {
  let active: Promise<LocalDiagnostics.SessionMemoryScanResult> | undefined
  return (request: LocalDiagnostics.SessionMemoryScanRequest) => {
    active ??= scan(request).finally(() => {
      active = undefined
    })
    return active
  }

  function scan(request: LocalDiagnostics.SessionMemoryScanRequest) {
    return new Promise<LocalDiagnostics.SessionMemoryScanResult>((resolve, reject) => {
      const child = spawn(process.execPath, [options.workerPath ?? join(import.meta.dirname, "session-memory-worker.js")], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "ignore"],
      })
      let output = ""
      let settled = false
      const finish = (error?: Error, result?: LocalDiagnostics.SessionMemoryScanResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill()
        if (error || !result) reject(error ?? new Error("session memory scan failed"))
        else resolve(result)
      }
      const timer = setTimeout(
        () => finish(new Error("session memory scan timed out")),
        options.timeoutMs ?? 10 * 60 * 1000,
      )
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        output += chunk
        if (output.length > 32 * 1024 * 1024) finish(new Error("session memory scan result exceeded limit"))
      })
      child.once("error", () => finish(new Error("session memory scanner unavailable")))
      child.once("exit", () => {
        try {
          const response = JSON.parse(output.trim()) as { ok?: unknown; result?: unknown }
          if (response.ok !== true) {
            finish(new Error("session memory scan failed"))
            return
          }
          finish(undefined, LocalDiagnostics.SessionMemoryScanResult.parse(response.result))
        } catch {
          finish(new Error("session memory scan returned invalid data"))
        }
      })
      child.stdin.end(`${JSON.stringify({ paths: options.paths, warmSessions: request.warmSessions })}\n`)
    })
  }
}
