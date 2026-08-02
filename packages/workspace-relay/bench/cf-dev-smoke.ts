#!/usr/bin/env bun
// Phase 0 local-first gate for the Cloudflare relay: boot the worker under
// `wrangler dev` (Miniflare/workerd — the REAL Cloudflare runtime, locally) and
// round-trip a smoke HTTP request + WS upgrade end-to-end through it. Proves
// DO bindings resolve, hibernation handlers register, PEM/env boot is correct,
// and — because it points the worker at a live bench resolver + echo target —
// that the DO's outbound upstream WebSocket open and the ported relay.trace
// frame work on workerd. Only after this passes should Phase 2 `wrangler deploy`.
//
//   bun bench/cf-dev-smoke.ts --config wrangler.toml      # stock worker
//   bun bench/cf-dev-smoke.ts --config wrangler-h2.toml   # H2 variant
//
// Writes .dev.vars in the package root (gitignored) for the boot secrets and
// removes it on teardown.

import { spawn } from "node:child_process"
import { rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { exportPKCS8, generateKeyPair } from "jose"
import { createBenchIdentity } from "./lib/tokens"
import { startBenchResolver } from "./lib/resolver"
import { startEchoTarget } from "./lib/echo-target"
import { runRow, type LoadgenConfig } from "./loadgen"
import { markdownRow, shapeLabel, MARKDOWN_HEADER } from "./lib/stats"

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function stringArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!
  return fallback
}

function numArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return Number(process.argv[index + 1])
  return fallback
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const port = probe.port ?? 0
  probe.stop(true)
  return port
}

async function waitForHealth(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      // worker still booting
    }
    await Bun.sleep(300)
  }
  return false
}

// .dev.vars is dotenv-style; single-line values only. PEMs carry newlines, so
// encode them with literal \n — the worker's pem() helper converts \n back to
// real newlines at boot (src/worker.ts).
function devVarLine(key: string, value: string): string {
  return `${key}=${value.replaceAll("\n", "\\n")}`
}

async function main() {
  const config = stringArg("config", "wrangler.toml")
  const connections = numArg("connections", 8)
  const wsMessages = numArg("ws-messages", 4)
  const workspaceId = "ws_bench"

  const identity = await createBenchIdentity({ workspaceId })
  const signing = await generateKeyPair("EdDSA", { extractable: true })
  const signingPem = await exportPKCS8(signing.privateKey as CryptoKey)

  const echo = startEchoTarget()
  const resolverToken = "bench-resolver-token"
  const resolver = startBenchResolver({ targetBaseUrl: echo.url, token: resolverToken })
  const workerPort = await freePort()
  const workerHttp = `http://127.0.0.1:${workerPort}`
  const workerWs = `ws://127.0.0.1:${workerPort}`
  const devVarsPath = join(PACKAGE_ROOT, ".dev.vars")

  const devVars = [
    devVarLine("CLAXEDO_RELAY_RESOLVER_URL", resolver.url),
    devVarLine("CLAXEDO_RELAY_RESOLVER_TOKEN", resolverToken),
    devVarLine("CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM", identity.publicKeyPem),
    devVarLine("CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM", signingPem),
  ].join("\n")
  await writeFile(devVarsPath, `${devVars}\n`)

  console.error(`[cf-dev] config=${config} echo=${echo.url} resolver=${resolver.url} worker=${workerHttp}`)

  const child = spawn(
    "bunx",
    ["wrangler", "dev", "-c", config, "--port", String(workerPort), "--ip", "127.0.0.1", "--local"],
    { cwd: PACKAGE_ROOT, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  )
  child.stdout.on("data", (chunk) => process.stderr.write(`[wrangler] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[wrangler] ${chunk}`))

  const teardown = async () => {
    try {
      child.kill("SIGTERM")
    } catch {
      // ignore
    }
    echo.stop()
    resolver.stop()
    await rm(devVarsPath, { force: true })
  }

  let exitCode = 0
  try {
    const healthy = await waitForHealth(`${workerHttp}/health`)
    if (!healthy) throw new Error("wrangler dev worker did not become healthy in time")
    const health = await (await fetch(`${workerHttp}/health`)).json()
    console.error(`[cf-dev] health: ${JSON.stringify(health)}`)

    const loadgenConfig: LoadgenConfig = {
      rowId: `cf-dev-smoke-${config.replace(/[^a-z0-9]+/gi, "-")}`,
      shape: shapeLabel({ concurrency: connections, wsMessagesPerConnection: wsMessages }),
      relayWsUrl: workerWs,
      relayHttpUrl: workerHttp,
      directWsUrl: echo.wsUrl,
      directHttpUrl: echo.url,
      workspaceId,
      wsPath: "/api/claxedo/pty/pty_1/connect",
      httpPath: "/api/wr/health",
      connections,
      concurrency: connections,
      wsMessagesPerConnection: wsMessages,
      wsMessageBytes: 64,
      httpRequests: connections,
      httpConcurrency: connections,
      requestTrace: true,
      openTimeoutMs: 30_000,
      messageTimeoutMs: 30_000,
      ratStyle: "subprotocol",
      relayOrigin: "http://localhost:5173",
      identity,
    }
    const row = await runRow(loadgenConfig)
    console.error(`\n${MARKDOWN_HEADER}\n| ${markdownRow(row)}\n`)
    console.error(`[cf-dev] trace source=${row.upstreamOpenSource} trace=${JSON.stringify(row.trace ?? null)}`)
    // Gate = worker booted (health), HTTP forward round-tripped, and the WS
    // upgrade bridged at least one message. Latency gates are cloud concerns.
    const httpOk = Number.isFinite(row.httpP99OverheadMs)
    const wsOk = row.relayedWsMessages.delivered > 0 && row.holderSetup.delivered > 0
    if (httpOk && wsOk) {
      console.error(`[cf-dev] GATE PASS: ${config} booted on workerd; HTTP + WS round-tripped (holders ${row.holderSetup.delivered}/${row.holderSetup.attempted}, ws msgs ${row.relayedWsMessages.delivered}/${row.relayedWsMessages.attempted})`)
    } else {
      console.error(`[cf-dev] GATE FAIL: httpOk=${httpOk} wsOk=${wsOk} — see row above and wrangler logs`)
      exitCode = 1
    }
  } catch (err) {
    console.error("[cf-dev] failed:", err)
    exitCode = 2
  } finally {
    await teardown()
  }
  process.exit(exitCode)
}

main()
