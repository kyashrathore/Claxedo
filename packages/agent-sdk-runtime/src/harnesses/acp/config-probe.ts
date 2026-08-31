import type { AgentConfigOption } from "../../index"
import { probeTimeoutMs } from "./helpers"
import type { ACPProcess } from "./process"

type AcpConfigProbeInput = {
  cached(): AgentConfigOption[] | null
  activePromptCount(): number
  spawn(): Promise<ACPProcess>
  boot(process: ACPProcess, timeoutMs: number): Promise<unknown>
}

/** Owns bounded ACP process discovery and live config-option cache polling. */
export async function probeAcpConfigOptions(input: AcpConfigProbeInput): Promise<AgentConfigOption[]> {
  const cached = input.cached()
  if (cached) return cached
  if (input.activePromptCount() > 0) {
    throw new Error("ACP harness config options are temporarily unavailable while a prompt is active")
  }
  const process = await bounded("ACP mode probe", input.spawn())
  if (process.cachedConfigOptions) return process.cachedConfigOptions as AgentConfigOption[]
  await input.boot(process, probeTimeoutMs())
  if (!process.cachedConfigOptions) await waitForConfigCache(process)
  if (!process.cachedConfigOptions) throw new Error("ACP harness did not return live config options")
  return process.cachedConfigOptions as AgentConfigOption[]
}

async function bounded<T>(label: string, operation: Promise<T>): Promise<T> {
  const timeoutMs = probeTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForConfigCache(process: ACPProcess): Promise<void> {
  const timeoutMs = probeTimeoutMs()
  await new Promise<void>((resolve) => {
    let poll: ReturnType<typeof setInterval> | undefined
    const done = () => {
      clearTimeout(timeout)
      if (poll) clearInterval(poll)
      resolve()
    }
    const timeout = setTimeout(done, timeoutMs)
    poll = setInterval(() => {
      if (process.cachedConfigOptions) done()
    }, 100)
  })
}
