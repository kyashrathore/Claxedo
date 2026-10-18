import path from "node:path"
import { pathToFileURL } from "node:url"
import { isRecord } from "@claxedo/helpers/guards"

export type { AppFacts, ClockFrame, FrameLog, PageSettle, ReadyGates } from "agent-app-benchmark/driver-sdk"

type DriverSdk = typeof import("agent-app-benchmark/driver-sdk")

const SDK_EXPORTS = ["serveDriver", "settleExpression", "frameLogOf"] as const satisfies ReadonlyArray<keyof DriverSdk>

function isDriverSdk(module: unknown): module is DriverSdk {
  return isRecord(module) && SDK_EXPORTS.every((name) => typeof module[name] === "function")
}

async function loadSdk(): Promise<DriverSdk> {
  const root = process.env.AGENT_APP_BENCHMARK_ROOT?.trim()
  if (!root) return import("agent-app-benchmark/driver-sdk")
  const entry = pathToFileURL(path.join(path.resolve(root), "src", "driver-sdk.mjs")).href
  const loaded: unknown = await import(entry)
  if (!isDriverSdk(loaded)) throw new Error(`${entry} is not the agent-app-benchmark driver SDK`)
  return loaded
}

export const sdk = await loadSdk()
