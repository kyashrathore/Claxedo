#!/usr/bin/env bun
// Real-world-shape dial-in load: drive K independent tunnels CONCURRENTLY, each
// with a FIXED per-tunnel load, and watch how per-tunnel relay overhead behaves
// as K grows. This answers the validity objection to the single-tunnel stress:
// the single-tunnel 10k/100k runs funneled the whole platform's messages through
// ONE tunnel (a pathological hot session). Real hosted use spreads traffic over
// MANY tunnels — each its own DO room. If dial-in scales by tunnel-count (as the
// unlimited-DO-instances model predicts), per-tunnel overhead stays ~flat as K
// rises while aggregate throughput scales K×.
//
//   bun bench/multitunnel-run.ts \
//     --manifest bench/reports/multitunnel-latest.json \
//     --relay wss://claxedo-workspace-relay-reeval.kanusdlp.workers.dev \
//     --private-key-pem <abs path to rat.key.pem> \
//     --per-tunnel-conns 10 --per-tunnel-msgs 100
//
// per-tunnel-conns × per-tunnel-msgs = messages each tunnel carries;
// × (registered tunnels) = aggregate messages this run pushes concurrently.
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runRow, type LoadgenConfig } from "./loadgen"
import { percentile, round2 } from "./lib/stats"

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const REPORTS_DIR = join(PACKAGE_ROOT, "bench/reports")

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : fallback
}

async function main() {
  const manifestPath = arg("manifest", join(REPORTS_DIR, "multitunnel-latest.json"))!
  const relay = arg("relay")
  const relayHttp = arg("relay-http", relay?.replace(/^ws/, "http"))
  const pem = arg("private-key-pem")
  const perTunnelConns = Number(arg("per-tunnel-conns", "10"))
  const perTunnelMsgs = Number(arg("per-tunnel-msgs", "100"))
  const limit = arg("limit") ? Number(arg("limit")) : undefined
  if (!relay || !pem) { console.error("[mt-run] --relay and --private-key-pem required"); process.exit(2) }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  let tunnels: any[] = manifest.manifest.filter((m: any) => m.registered)
  if (limit) tunnels = tunnels.slice(0, limit)
  if (tunnels.length === 0) { console.error("[mt-run] no registered tunnels in manifest"); process.exit(1) }

  const aggregate = tunnels.length * perTunnelConns * perTunnelMsgs
  console.error(
    `[mt-run] K=${tunnels.length} tunnels × ${perTunnelConns} conns × ${perTunnelMsgs} msgs ` +
      `= ${aggregate} aggregate messages, all concurrent`,
  )

  const buildConfig = (t: any): LoadgenConfig => ({
    rowId: `mt-${t.workspaceId}`,
    shape: `c${perTunnelConns}x${perTunnelMsgs}`,
    relayWsUrl: relay,
    relayHttpUrl: relayHttp!,
    directWsUrl: t.directWsUrl,
    directHttpUrl: t.directHttpUrl,
    workspaceId: t.workspaceId,
    // Same path for direct + relay; the preview token authorizes the DIRECT
    // baseline (echo behind Daytona preview) and is ignored by the echo when it
    // arrives via the tunnel. Mirrors the single-tunnel run's --path.
    wsPath: `/ws${t.previewToken ? `?DAYTONA_SANDBOX_AUTH_KEY=${t.previewToken}` : ""}`,
    httpPath: "/health",
    connections: perTunnelConns,
    concurrency: perTunnelConns,
    wsMessagesPerConnection: perTunnelMsgs,
    wsMessageBytes: 64,
    httpRequests: 0,
    httpConcurrency: 1,
    requestTrace: true,
    openTimeoutMs: 60_000,
    messageTimeoutMs: 60_000,
    ratStyle: "subprotocol",
    relayOrigin: "http://localhost:5173",
    ratPrivateKeyPem: pem,
  })

  const startedAt = performance.now()
  // All K tunnels driven at once — this is the concurrent multi-tunnel window.
  const rows = await Promise.all(
    tunnels.map((t) =>
      runRow(buildConfig(t)).catch((err) => {
        console.error(`[mt-run] tunnel ${t.workspaceId} failed:`, err?.message ?? err)
        return null
      }),
    ),
  )
  const wallMs = round2(performance.now() - startedAt)

  const ok = rows.filter((r): r is NonNullable<typeof r> => r !== null)
  const overheads = ok.map((r) => r.wsMessageP99OverheadMs).filter((v): v is number => typeof v === "number")
  const totalRelayed = ok.reduce((s, r) => s + r.relayedWsMessages.delivered, 0)
  const totalAttempted = ok.reduce((s, r) => s + r.relayedWsMessages.attempted, 0)
  const totalHolders = ok.reduce((s, r) => s + r.holderSetup.delivered, 0)
  const totalHolderAttempts = ok.reduce((s, r) => s + r.holderSetup.attempted, 0)

  const summary = {
    tunnels: tunnels.length,
    tunnelsOk: ok.length,
    perTunnelConns,
    perTunnelMsgs,
    aggregateMessages: aggregate,
    perTunnelOverheadMs: {
      min: overheads.length ? round2(Math.min(...overheads)) : null,
      median: overheads.length ? round2(percentile(overheads, 50)) : null,
      p95: overheads.length ? round2(percentile(overheads, 95)) : null,
      max: overheads.length ? round2(Math.max(...overheads)) : null,
    },
    relayedDelivered: `${totalRelayed}/${totalAttempted}`,
    holders: `${totalHolders}/${totalHolderAttempts}`,
    throughputMsgPerSec: round2((totalRelayed / wallMs) * 1000),
    wallMs,
  }

  console.error(`\n=== multi-tunnel result (K=${tunnels.length}) ===`)
  console.error(JSON.stringify(summary, null, 2))

  await mkdir(REPORTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  await writeFile(join(REPORTS_DIR, `mt-run-K${tunnels.length}-${perTunnelConns}x${perTunnelMsgs}-${stamp}.json`), JSON.stringify({ summary, rows: ok }, null, 2))
  // Compact one-liner for quick scanning across K sweeps.
  console.log(
    `K=${tunnels.length} perTunnel=${perTunnelConns}x${perTunnelMsgs} agg=${aggregate} ` +
      `overhead(min/med/p95/max)=${summary.perTunnelOverheadMs.min}/${summary.perTunnelOverheadMs.median}/${summary.perTunnelOverheadMs.p95}/${summary.perTunnelOverheadMs.max}ms ` +
      `relayed=${summary.relayedDelivered} holders=${summary.holders} thrpt=${summary.throughputMsgPerSec}msg/s wall=${summary.wallMs}ms`,
  )
  process.exit(ok.length === tunnels.length ? 0 : 1)
}

main().catch((err) => {
  console.error("[mt-run] failed:", err)
  process.exit(2)
})
