#!/usr/bin/env bun
// REPRO SCRIPT — relay 500 on host-tunnel RE-REGISTRATION.
//
// Found by the 2026-07-30 cloud dial-in bench: a host that dials in a second
// tunnel for a hostId whose PRIOR tunnel the relay still holds was answered
// with HTTP 500 instead of a clean replacement. That is the reconnect path — a
// host whose socket dropped without the relay observing the close re-dials into
// exactly this state — so a 500 here turns one lost socket into a host that
// cannot get back in.
//
// This script is DIAGNOSTIC ONLY. It does not assert and does not gate; the
// relay-side fix is deliberately out of scope for the change that added it.
// It boots the same local topology as `local-dialin.ts` (real shipping relay
// process, bench resolver in user-hosted mode), holds tunnel A open, then dials
// tunnel B for the SAME hostId and reports what the second upgrade returned.
//
//   bun bench/scratch-reregister.ts

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { exportPKCS8 } from "jose"
import { benchHostTunnelTokenFromPrivatePem, createBenchIdentity } from "./lib/tokens"
import { startBenchResolver } from "./lib/resolver"
import { startEchoTarget } from "./lib/echo-target"
import { startWorkspaceRelayHostTunnel } from "../../workspace-runtime/src/workspace-relay-host-tunnel"

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

async function main() {
  const workspaceId = "ws_bench"
  const hostId = "host_bench"

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

  const tunnels: Array<{ close(): void }> = []
  const teardown = () => {
    for (const tunnel of tunnels) {
      try { tunnel.close() } catch {}
    }
    try { child.kill("SIGTERM") } catch {}
    echo.stop()
    resolver.stop()
  }

  let exitCode = 0
  try {
    if (!(await waitForHealth(`${relayHttp}/health`))) throw new Error("relay did not become healthy")
    const htt = await benchHostTunnelTokenFromPrivatePem(privateKeyPem, { workspaceIds: [workspaceId], hostId })

    const dial = (label: string) =>
      new Promise<void>((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          resolve()
        }
        tunnels.push(startWorkspaceRelayHostTunnel({
          relayUrl: relayHttp,
          hostId,
          workspaceIds: [workspaceId],
          localBaseUrl: echo.url,
          resolveLocalUrl: ({ path }) => new URL(path.replace(/^\/+/, ""), `${echo.url.replace(/\/+$/, "")}/`),
          tokenProvider: () => Promise.resolve(htt),
          // One attempt only: the point is what the FIRST upgrade returns, not
          // whether backoff eventually wins.
          maxReconnectAttempts: 0,
          onEvent: (event) => {
            console.error(`[reregister] ${label} ${JSON.stringify(event)}`)
            if (event.type === "open" || event.type === "closed" || event.type === "auth-failed") done()
          },
        }))
        setTimeout(done, 10_000)
      })

    await dial("tunnel-A")
    // Tunnel A is still held by the relay here — nothing closed it. This is the
    // state a reconnecting host arrives in.
    await dial("tunnel-B")
    await Bun.sleep(500)

    // Ask the relay what it thinks it holds. A clean replacement leaves exactly
    // one tunnel for the hostId; the observed cloud behaviour was a 500 on the
    // second upgrade instead.
    const debug = await fetch(`${relayHttp}/workspaces/${workspaceId}/debug`).catch(() => undefined)
    console.error(`[reregister] relay debug status=${debug?.status ?? "unreachable"} body=${debug ? await debug.text() : "n/a"}`)
    console.error("[reregister] read the tunnel-B events above: an auth-failed/closed with a 500 is the defect")
  } catch (err) {
    console.error("[reregister] failed:", err)
    exitCode = 2
  } finally {
    teardown()
  }
  process.exit(exitCode)
}

main()
