#!/usr/bin/env bun
// Phase 0 gate: prove the loadgen produces the full metric set end-to-end
// against a REAL locally-booted Bun relay (`bun src/main.ts`) bridging to a
// real local WS/HTTP target. Nothing here is mocked — the relay is the shipping
// process, booted with the same env vars production uses; only the RAT issuer
// and target resolver are bench-supplied (the control plane's job in prod).
//
// Boots: echo target -> bench resolver -> `bun src/main.ts` child -> loadgen.
// Writes a report row to bench/reports and tears everything down.
//
//   bun bench/local-dry-run.ts [--connections 20] [--ws-messages 4] [--handshake-delay-ms 0]

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createBenchIdentity } from "./lib/tokens"
import { startBenchResolver } from "./lib/resolver"
import { startEchoTarget } from "./lib/echo-target"
import { runRow, writeReport, type LoadgenConfig } from "./loadgen"
import { markdownRow, MARKDOWN_HEADER } from "./lib/stats"

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  const port = probe.port ?? 0
  probe.stop(true)
  return port
}

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      // relay still booting
    }
    await Bun.sleep(150)
  }
  return false
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return Number(process.argv[index + 1])
  return fallback
}

async function main() {
  const connections = arg("connections", 20)
  const concurrency = arg("concurrency", connections)
  const wsMessages = arg("ws-messages", 4)
  const handshakeDelayMs = arg("handshake-delay-ms", 0)
  const workspaceId = "ws_bench"

  const identity = await createBenchIdentity({ workspaceId })
  const echo = startEchoTarget({ handshakeDelayMs })
  const resolverToken = "bench-resolver-token"
  const resolver = startBenchResolver({ targetBaseUrl: echo.url, token: resolverToken })
  const relayPort = await freePort()
  const relayHttp = `http://127.0.0.1:${relayPort}`
  const relayWs = `ws://127.0.0.1:${relayPort}`

  console.error(`[dry-run] echo=${echo.url} resolver=${resolver.url} relay=${relayHttp}`)

  const child = spawn("bun", ["run", "src/main.ts"], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      CLAXEDO_WORKSPACE_RELAY_HOST: "127.0.0.1",
      CLAXEDO_WORKSPACE_RELAY_PORT: String(relayPort),
      CLAXEDO_RELAY_RESOLVER_URL: resolver.url,
      CLAXEDO_RELAY_RESOLVER_TOKEN: resolverToken,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: identity.publicKeyPem,
      CLAXEDO_RELAY_SYNTHETIC_PROBE_DISABLED: "1",
      // Force the local process into an unbounded direct-HTTP admission (dev
      // default) — production sets =64; the local gate only proves boot/config.
      NODE_ENV: process.env.NODE_ENV === "production" ? "development" : (process.env.NODE_ENV ?? "development"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk) => process.stderr.write(`[relay] ${chunk}`))
  child.stderr.on("data", (chunk) => process.stderr.write(`[relay] ${chunk}`))

  const teardown = () => {
    try {
      child.kill("SIGTERM")
    } catch {
      // ignore
    }
    echo.stop()
    resolver.stop()
  }

  let exitCode = 0
  try {
    const healthy = await waitForHealth(`${relayHttp}/health`)
    if (!healthy) throw new Error("relay did not become healthy in time")
    console.error("[dry-run] relay healthy; running loadgen smoke row")

    const config: LoadgenConfig = {
      rowId: "local-dry-run",
      shape: `c${connections}/load${connections}`,
      relayWsUrl: relayWs,
      relayHttpUrl: relayHttp,
      directWsUrl: echo.wsUrl,
      directHttpUrl: echo.url,
      workspaceId,
      wsPath: "/api/claxedo/pty/pty_1/connect",
      httpPath: "/api/wr/health",
      connections,
      concurrency,
      wsMessagesPerConnection: wsMessages,
      wsMessageBytes: 64,
      httpRequests: connections,
      httpConcurrency: connections,
      requestTrace: true,
      openTimeoutMs: 15_000,
      messageTimeoutMs: 15_000,
      ratStyle: "subprotocol",
      relayOrigin: "http://localhost:5173",
      identity,
    }
    const row = await runRow(config)
    const { jsonPath, mdPath } = await writeReport(row, join(PACKAGE_ROOT, "bench/reports"))
    console.error(`\n${MARKDOWN_HEADER}\n| ${markdownRow(row)}\n`)
    console.error(`[dry-run] trace source=${row.upstreamOpenSource} trace=${JSON.stringify(row.trace ?? null)}`)
    console.error(`[dry-run] wrote ${jsonPath}`)
    console.error(`[dry-run] wrote ${mdPath}`)
    if (!row.gates.pass) {
      console.error("[dry-run] GATE FAIL: metric set produced but a gate did not pass")
      exitCode = 1
    } else {
      console.error("[dry-run] GATE PASS: full metric set produced against a real local relay")
    }
  } catch (err) {
    console.error("[dry-run] failed:", err)
    exitCode = 2
  } finally {
    teardown()
  }
  process.exit(exitCode)
}

main()
