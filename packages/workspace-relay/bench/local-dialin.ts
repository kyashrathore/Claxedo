#!/usr/bin/env bun
// Local-first proof of the DIAL-IN cloud path — the gate the RUNBOOK requires
// before touching cloud. Boots the FULL dial-in topology on localhost with the
// real shipping relay process (no mocks):
//
//   echo target (localhost) ─┐
//                            │  in-process dial-in agent (startWorkspaceRelay-
//                            │  HostTunnel) dials INTO the relay with an HTT,
//                            ▼  forwards channels to the echo target
//   `bun src/main.ts` relay ◀── browser WS (RAT) dials IN; relay rendezvouses
//   (bench resolver =            the two inbound sockets — NO dial-out
//    user-hosted mode)
//
// Proves the relay routes a browser WS through the held tunnel (relayed WS 1/1)
// with the resolver in user-hosted mode. Same key mints the HTT and the RAT and
// is trusted by the relay via CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM.
//
//   bun bench/local-dialin.ts [--messages 4]

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createBenchIdentity, benchHostTunnelTokenFromPrivatePem } from "./lib/tokens"
import { startBenchResolver } from "./lib/resolver"
import { startEchoTarget } from "./lib/echo-target"
import { probeWebSocket } from "./lib/ws"
import { startWorkspaceRelayHostTunnel } from "../../workspace-runtime/src/workspace-relay-host-tunnel"
import { exportPKCS8 } from "jose"

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
      if ((await fetch(url)).ok) return true
    } catch {}
    await Bun.sleep(150)
  }
  return false
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback
}

async function main() {
  const messages = arg("messages", 4)
  const workspaceId = "ws_bench"
  const hostId = "host_bench"

  // One bench identity mints BOTH the HTT (host leg) and the RAT (browser leg);
  // its public half is what the relay trusts.
  const identity = await createBenchIdentity({ workspaceId, hostId })
  const privateKeyPem = await exportPKCS8(identity.privateKey)

  const echo = startEchoTarget({})
  const resolverToken = "bench-resolver-token"
  const resolver = startBenchResolver({
    targetBaseUrl: echo.url,
    token: resolverToken,
    accessMode: "user-hosted",
  })
  const relayPort = await freePort()
  const relayHttp = `http://127.0.0.1:${relayPort}`
  const relayWs = `ws://127.0.0.1:${relayPort}`

  console.error(`[local-dialin] echo=${echo.url} resolver=${resolver.url} relay=${relayHttp}`)

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
      NODE_ENV: process.env.NODE_ENV === "production" ? "development" : (process.env.NODE_ENV ?? "development"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (c) => process.stderr.write(`[relay] ${c}`))
  child.stderr.on("data", (c) => process.stderr.write(`[relay] ${c}`))

  let tunnel: { close(): void } | undefined
  const teardown = () => {
    try { tunnel?.close() } catch {}
    try { child.kill("SIGTERM") } catch {}
    echo.stop()
    resolver.stop()
  }

  let exitCode = 0
  try {
    if (!(await waitForHealth(`${relayHttp}/health`))) throw new Error("relay did not become healthy")
    console.error("[local-dialin] relay healthy")

    // Dial the tunnel IN (in-process, using the global WebSocket the same way
    // the sandbox agent will). Forward every channel to the echo target.
    const htt = await benchHostTunnelTokenFromPrivatePem(privateKeyPem, { workspaceIds: [workspaceId], hostId })
    let opened = false
    tunnel = startWorkspaceRelayHostTunnel({
      relayUrl: relayHttp,
      hostId,
      workspaceIds: [workspaceId],
      localBaseUrl: echo.url,
      resolveLocalUrl: ({ path }) => new URL(path.replace(/^\/+/, ""), `${echo.url.replace(/\/+$/, "")}/`),
      tokenProvider: () => Promise.resolve(htt),
      onEvent: (event) => {
        if (event.type === "open") opened = true
        console.error(`[local-dialin] tunnel ${JSON.stringify(event)}`)
      },
    })

    const openDeadline = Date.now() + 10_000
    while (!opened && Date.now() < openDeadline) await Bun.sleep(100)
    if (!opened) throw new Error("tunnel did not register (open) with the relay")
    console.error("[local-dialin] tunnel registered")

    // Browser WS in through the relay → must land in the tunnel channel → echo.
    const rat = await identity.mintRat({ workspaceId, hostId })
    const url = `${relayWs}/workspaces/${workspaceId}/ws`
    const probe = await probeWebSocket({
      url,
      messages,
      protocols: [`claxedo-rat.${rat}`],
      headers: { origin: "http://localhost:5173" },
      openTimeoutMs: 10_000,
      messageTimeoutMs: 10_000,
    })
    console.error(
      `[local-dialin] relayed WS: connected=${probe.connected} delivered=${probe.delivered}/${probe.sent}${probe.failureCode ? ` failure=${probe.failureCode}` : ""}`,
    )
    if (probe.connected && probe.delivered === messages) {
      console.error(`[local-dialin] GATE PASS: relayed WS ${probe.delivered}/${messages} through the dial-in tunnel`)
    } else {
      console.error("[local-dialin] GATE FAIL: relayed WS did not round-trip")
      exitCode = 1
    }
  } catch (err) {
    console.error("[local-dialin] failed:", err)
    exitCode = 2
  } finally {
    teardown()
  }
  process.exit(exitCode)
}

main()
