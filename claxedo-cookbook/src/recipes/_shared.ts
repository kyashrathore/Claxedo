// Shared helpers for cookbook recipes. Kept deliberately tiny and boring:
// a recipe file should be readable on its own, and this file should never
// become a framework. Only prerequisite detection and uniform printing live
// here.
import { spawnSync } from "node:child_process"
import net from "node:net"

/** Print the recipe banner. Every recipe calls this first. */
export function banner(input: { recipe: string; what: string; wow: string }) {
  console.log(`\n=== ${input.recipe} ===`)
  console.log(`what: ${input.what}`)
  console.log(`wow:  ${input.wow}\n`)
}

/**
 * Print a clean SKIP and exit 0. Recipes must never stack-trace on a missing
 * prerequisite — a SKIP with the reason and the fix is part of the contract.
 */
export function skip(reason: string, fix?: string): never {
  console.log(`SKIP: ${reason}`)
  if (fix) console.log(`fix:  ${fix}`)
  process.exit(0)
}

/** True when a binary resolves on PATH. */
export function hasBinary(name: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" })
  return probe.status === 0
}

/** True when the docker daemon answers. */
export function dockerUp(): boolean {
  const probe = spawnSync("docker", ["info"], { stdio: "ignore" })
  return probe.status === 0
}

/** Reserve a free loopback port. */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address) {
        const port = address.port
        server.close(() => resolve(port))
        return
      }
      server.close(() => reject(new Error("no port assigned")))
    })
    server.on("error", reject)
  })
}

/** Poll an HTTP URL until it answers or the deadline passes. */
export async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`${url} -> ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}`)
}

export type DetectedHarness = {
  /** Harness key as the agent-sdk-runtime facade expects it. */
  id: "claude" | "codex" | "cursor" | "opencode"
  access: "native" | "acp"
  /** The binary that made it eligible. */
  binary: string
  /** Env var the harness expects for credentials, when access is native. */
  envKey?: string
  available: boolean
  reason: string
}

/**
 * Detect which harnesses can actually run on this machine. Recipes run what
 * is available and report the rest as detected-but-skipped — never fake a
 * harness.
 */
export function detectHarnesses(): DetectedHarness[] {
  const candidates: Array<Omit<DetectedHarness, "available" | "reason">> = [
    { id: "claude", access: "acp", binary: "claude-agent-acp" },
    { id: "codex", access: "acp", binary: "codex-acp" },
    { id: "cursor", access: "acp", binary: "cursor-agent-acp" },
    { id: "claude", access: "native", binary: "claude", envKey: "ANTHROPIC_API_KEY" },
    { id: "codex", access: "native", binary: "codex", envKey: "OPENAI_API_KEY" },
    { id: "cursor", access: "native", binary: "cursor-agent", envKey: "CURSOR_API_KEY" },
  ]
  return candidates.map((candidate) => {
    if (!hasBinary(candidate.binary)) {
      return { ...candidate, available: false, reason: `binary "${candidate.binary}" not on PATH` }
    }
    return { ...candidate, available: true, reason: "ok" }
  })
}

/** Uniform result block — the docs quote this output verbatim. */
export function printResult(title: string, value: unknown) {
  console.log(`\n--- ${title} ---`)
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2))
  console.log(`--- end ---\n`)
}
