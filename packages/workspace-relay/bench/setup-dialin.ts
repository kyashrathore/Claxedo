#!/usr/bin/env bun
// Orchestrator for the DIAL-IN cloud path (docs/tech-docs/cloudflare-relay-
// evaluation.md "Inbound-rendezvous", "Dial-in auth flow"). It bundles the
// sandbox-side dial-in agent to a single node .cjs, mints a Host Tunnel Token,
// uploads both into an existing Daytona sandbox, starts the agent in a
// background session, and verifies the tunnel registered — either by observing
// the agent's `open` event or, with --relay + --private-key-pem, by round-
// tripping ONE browser WS through the relay into the tunnel.
//
// Unlike setup-target.ts (which exposes the sandbox's echo server via a PUBLIC
// Daytona preview URL for the relay to DIAL OUT to), this leaves the echo server
// on localhost only: the sandbox agent dials INTO the relay and forwards
// channels to its own localhost. No preview URL, no preview token — the relay
// never dials the sandbox.
//
//   DAYTONA_API_KEY=... bun bench/setup-dialin.ts \
//     --sandbox-id <id> \
//     --relay wss://claxedo-workspace-relay-reeval.kanusdlp.workers.dev \
//     --workspace ws_reeval_dtn --host host_bench \
//     --private-key-pem <abs path to rat.key.pem> \
//     [--local-url http://localhost:3939] [--htt-ttl 1800] [--no-verify]
//
// Prereqs: the echo server must already be running inside the sandbox on
// --local-url's port (bench/setup-target.ts starts one on 3939; only its
// localhost listener is used here, not its preview URL), and the deployed relay
// must be configured with the resolver in user-hosted mode (ACCESS_MODE=
// user-hosted) so it routes clients into the tunnel instead of dialing out.
//
// Prints (stderr + JSON to bench/reports/dialin-<stamp>.json):
//   bundlePath        — the produced agent .cjs
//   registered        — whether the tunnel `open` event was observed
//   roundTrip         — { connected, delivered, sent } when verification ran

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { Daytona } from "@daytona/sdk"
import { benchHostTunnelTokenFromPrivatePem } from "./lib/tokens"
import { benchIdentityFromPrivatePem } from "./lib/tokens"
import { readFile } from "node:fs/promises"
import { probeWebSocket } from "./lib/ws"

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const REPORTS_DIR = join(PACKAGE_ROOT, "bench/reports")
const AGENT_ENTRY = join(PACKAGE_ROOT, "bench/dialin-agent.ts")
const BUNDLE_PATH = join(REPORTS_DIR, "dialin-agent.bundle.cjs")

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback
}

function flag(name: string) {
  return process.argv.includes(`--${name}`)
}

// Bundle the agent + its imported tunnel client + protocol package into a single
// CommonJS file the sandbox's node can run with no node_modules. platform:node
// keeps node builtins external and lets the tunnel client use global
// WebSocket/fetch (Node 22), exactly as production wires it.
async function bundleAgent(): Promise<string> {
  await mkdir(REPORTS_DIR, { recursive: true })
  await build({
    entryPoints: [AGENT_ENTRY],
    outfile: BUNDLE_PATH,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "warning",
  })
  console.error(`[dialin] bundled agent -> ${BUNDLE_PATH}`)
  return BUNDLE_PATH
}

async function resolvePem(value: string): Promise<string> {
  if (value.includes("BEGIN")) return value.replaceAll("\\n", "\n")
  return await readFile(value, "utf8")
}

async function main() {
  const sandboxId = arg("sandbox-id")
  const relayUrl = arg("relay")
  const workspaceId = arg("workspace", "ws_reeval_dtn")!
  const hostId = arg("host", "host_bench")!
  const localUrl = arg("local-url", "http://localhost:3939")!
  const httpTtl = Number(arg("htt-ttl", "1800"))
  const pemArg = arg("private-key-pem")
  const verify = !flag("no-verify")

  if (!sandboxId) {
    console.error("[dialin] --sandbox-id required")
    process.exit(2)
  }
  const key = process.env.DAYTONA_API_KEY
  if (!key) {
    console.error("[dialin] DAYTONA_API_KEY required")
    process.exit(2)
  }
  if (!pemArg) {
    console.error("[dialin] --private-key-pem <file|pem> required (mints the HTT; its public half is trusted by the relay)")
    process.exit(2)
  }
  const privateKeyPem = await resolvePem(pemArg)

  // 1. Bundle the agent and mint the HTT.
  const bundlePath = await bundleAgent()
  const bundleSource = await readFile(bundlePath, "utf8")
  const htt = await benchHostTunnelTokenFromPrivatePem(privateKeyPem, {
    workspaceIds: [workspaceId],
    hostId,
    ttlSeconds: httpTtl,
  })
  console.error(`[dialin] minted HTT (host=${hostId} workspace=${workspaceId} ttl=${httpTtl}s)`)

  if (!relayUrl) {
    console.error("[dialin] --relay <wss://…> required to start the agent (it dials this relay)")
    process.exit(2)
  }

  const daytona = new Daytona({ apiKey: key })
  const sandbox = await daytona.get(sandboxId)

  // 2. Upload the bundle + HTT + relay config into the sandbox. Secrets are
  //    written to files (not passed on the command line where they'd land in
  //    process listings / shell history).
  console.error("[dialin] uploading agent bundle + HTT into sandbox…")
  const bundleB64 = Buffer.from(bundleSource).toString("base64")
  const httB64 = Buffer.from(htt).toString("base64")
  await sandbox.process.executeCommand(`bash -lc 'echo ${bundleB64} | base64 -d > /tmp/dialin-agent.cjs'`)
  await sandbox.process.executeCommand(`bash -lc 'umask 077; echo ${httB64} | base64 -d > /tmp/dialin.htt'`)

  // 3. Start the agent in a detached background session so it outlives this call.
  const sessionId = "bench-dialin"
  try {
    await sandbox.process.deleteSession(sessionId)
  } catch {}
  await sandbox.process.createSession(sessionId)
  const startCmd = [
    "RELAY_URL=" + JSON.stringify(relayUrl),
    "HOST_ID=" + JSON.stringify(hostId),
    "WORKSPACE_ID=" + JSON.stringify(workspaceId),
    "LOCAL_URL=" + JSON.stringify(localUrl),
    'HTT="$(cat /tmp/dialin.htt)"',
    "nohup node /tmp/dialin-agent.cjs > /tmp/dialin.log 2>&1 & echo started",
  ].join(" ")
  console.error("[dialin] starting dial-in agent in background session…")
  await sandbox.process.executeSessionCommand(sessionId, {
    command: `bash -lc '${startCmd}'`,
    runAsync: true,
  } as any)

  // 4. Poll the agent log for the tunnel `open` event (the runtime successfully
  //    registered its inbound tunnel with the relay).
  let registered = false
  let lastLog = ""
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const tail = await sandbox.process.executeCommand(`bash -lc 'cat /tmp/dialin.log 2>/dev/null || true'`)
    lastLog = String((tail as any).result ?? (tail as any).stdout ?? "")
    if (/"type":"open"/.test(lastLog)) {
      registered = true
      break
    }
    if (/"type":"auth-failed"/.test(lastLog)) break
  }
  console.error(`[dialin] tunnel registered=${registered}`)
  if (lastLog) console.error(`[dialin] agent log tail:\n${lastLog.split("\n").slice(-8).join("\n")}`)

  // 5. Prove the round-trip: mint a RAT and open ONE browser WS through the
  //    relay. If the client frame echoes back, the relay held an inbound tunnel
  //    and routed the client into it (dial-in), not a dial-out.
  let roundTrip: { connected: boolean; sent: number; delivered: number; failureCode?: string } | undefined
  if (verify && registered) {
    const identity = await benchIdentityFromPrivatePem(privateKeyPem, { workspaceId, hostId })
    const rat = await identity.mintRat({ workspaceId, hostId })
    const url = `${relayUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/workspaces/${encodeURIComponent(workspaceId)}/ws`
    console.error(`[dialin] round-trip probe -> ${url}`)
    const probe = await probeWebSocket({
      url,
      messages: 1,
      protocols: [`claxedo-rat.${rat}`],
      headers: { origin: "http://localhost:5173", "x-claxedo-relay-ws-trace": "1" },
      requestTrace: true,
      openTimeoutMs: 15_000,
      messageTimeoutMs: 15_000,
    })
    roundTrip = { connected: probe.connected, sent: probe.sent, delivered: probe.delivered, ...(probe.failureCode ? { failureCode: probe.failureCode } : {}) }
    console.error(`[dialin] round-trip: connected=${probe.connected} delivered=${probe.delivered}/${probe.sent}${probe.failureCode ? ` failure=${probe.failureCode}` : ""}`)
  }

  await mkdir(REPORTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const path = join(REPORTS_DIR, `dialin-${stamp}.json`)
  await writeFile(
    path,
    JSON.stringify(
      { sandboxId, relayUrl, workspaceId, hostId, localUrl, bundlePath, registered, ...(roundTrip ? { roundTrip } : {}) },
      null,
      2,
    ),
  )
  console.error(`[dialin] wrote ${path}`)

  const ok = registered && (!verify || (roundTrip?.connected && roundTrip.delivered >= 1))
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error("[dialin] failed:", err)
  process.exit(1)
})
