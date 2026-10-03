import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import path from "node:path"
import { captureOutput, stopProcess } from "../process"
import type { ScriptedAcpWebSocket } from "./websocket-contract"
export type { ScriptedAcpWebSocket } from "./websocket-contract"
import { ACP_RED_ENV } from "./script"

export async function startScriptedAcpWebSocketProcess(input: { bunPath: string; scriptDir: string; red?: boolean }): Promise<ScriptedAcpWebSocket> {
  const entry = path.join(import.meta.dirname, "websocket-process-entry.ts")
  const child = spawn(input.bunPath, [entry, input.scriptDir], {
    env: { ...process.env, [ACP_RED_ENV]: input.red ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const owned = captureOutput(child)
  const lines = createInterface({ input: child.stdout })
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, url?: string) => {
        clearTimeout(timer)
        lines.off("line", ready)
        child.off("exit", exited)
        child.off("error", failed)
        if (error) reject(error)
        else resolve(url!)
      }
      const ready = (line: string) => {
        try {
          const value = JSON.parse(line) as { url?: unknown }
          if (typeof value.url !== "string" || !value.url.startsWith("ws://127.0.0.1:")) throw new Error(`Invalid ACP server address: ${line}`)
          finish(undefined, value.url)
        } catch (error) { finish(error as Error) }
      }
      const exited = () => finish(new Error(`Scripted ACP WebSocket server exited before ready: ${owned.log()}`))
      const failed = (error: Error) => finish(error)
      const timer = setTimeout(() => finish(new Error(`Scripted ACP WebSocket server startup timed out: ${owned.log()}`)), 10_000)
      lines.on("line", ready)
      child.once("exit", exited)
      child.once("error", failed)
    })
    return { url, close: () => stopProcess(child) }
  } catch (error) {
    if (child.pid !== undefined) await stopProcess(child)
    throw error
  } finally { lines.close() }
}
