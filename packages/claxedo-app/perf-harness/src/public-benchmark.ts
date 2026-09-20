#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { constants } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertPinnedPublicFramework, type PublicFrameworkPin } from "./public-framework-pin"

export type PublicBenchmarkInvocation = { pin: PublicFrameworkPin; cliPath: string }

/**
 * The framework CLI decides registration, case generation and result validity
 * from the tree it lives in, so the pin is checked against that tree before the
 * CLI is located or started. Resolving the driver SDK specifier only computes a
 * path; nothing framework-owned is loaded until the child process starts.
 */
export async function resolvePublicBenchmark(paths?: {
  manifestPath?: string
  frameworkRoot?: string
}): Promise<PublicBenchmarkInvocation> {
  const manifestPath = paths?.manifestPath ?? path.join(import.meta.dir, "../package.json")
  const frameworkRoot = paths?.frameworkRoot ?? fileURLToPath(new URL("../", import.meta.resolve("agent-app-benchmark/driver-sdk")))
  const pin = await assertPinnedPublicFramework({ manifestPath, frameworkRoot })
  const cliPath = path.join(frameworkRoot, "bin", "agent-app-benchmark.mjs")
  await access(cliPath)
  return { pin, cliPath }
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"] as const

export async function runPublicBenchmark(argv: string[]) {
  const { pin, cliPath } = await resolvePublicBenchmark()
  process.stderr.write(`agent-app-benchmark ${pin.installedCommit} (pinned ${pin.pinnedCommit})\n`)
  const child = spawn("node", [cliPath, ...argv], { stdio: "inherit" })
  // The framework run owns the driver, which owns the launched application, so
  // an interrupt has to reach the child and its exit has to be awaited;
  // killing this wrapper first would strand the application processes.
  const forward = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => void child.kill(signal)
    process.on(signal, handler)
    return () => process.off(signal, handler)
  })
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]))
    })
    if (signal) return 128 + constants.signals[signal]
    return code ?? 1
  } catch (error) {
    throw new Error(`Could not start ${cliPath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  } finally {
    for (const remove of forward) remove()
  }
}

if (import.meta.main) {
  process.exitCode = await runPublicBenchmark(process.argv.slice(2))
}
