import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"

import { readString } from "@claxedo/helpers/readers"

import { LocalDiagnostics } from "../src/shared/local-diagnostics"
import { createCdpClient, type CdpClient } from "./cdp-client"
import {
  assertExpectedArchitecture,
  byteReading,
  DIAGNOSTICS_RETAINED_BYTES_BUDGET,
  packagedSourcesReady,
  reading,
  requirePackagedSourceHealth,
  SECRET_SENTINEL,
  type DiagnosticsSmokeEvidence,
} from "./diagnostics-smoke-evidence"

export async function runPackagedSmoke() {
  assertExpectedArchitecture()
  const executable = process.env.CLAXEDO_DIAGNOSTICS_APP_EXECUTABLE ?? await discoverPackagedExecutable()
  const userData = await mkdtemp(join(tmpdir(), "claxedo-diagnostics-smoke-"))
  await mkdir(join(userData, "data"))
  const debugPort = await availablePort()
  const application = Bun.spawn({
    cmd: [
      executable,
      `--remote-debugging-port=${String(debugPort)}`,
      // CI-only concession: the unpacked linux-unpacked/ dir cannot carry a
      // setuid-root chrome-sandbox (installers set that bit at install time),
      // so Chromium aborts at boot on the runners. The INSTALLED app keeps
      // full sandboxing; this flag never ships.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
    env: {
      ...process.env,
      CLAXEDO_DESKTOP_USER_DATA_DIR: userData,
      CLAXEDO_DATA_DIR: join(userData, "data"),
      CLAXEDO_DIAGNOSTICS_SECRET_SENTINEL: SECRET_SENTINEL,
      CLAXEDO_DIAGNOSTICS_PACKAGED_SMOKE: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  try {
    const client = await connectToPackagedApp(debugPort, application)
    try {
      await waitForMainWindow(client)
      await requirePackagedMermaid(client)
      // Host metrics are on-demand: windows-cim/macos-ps/linux-proc stay
      // `warming-up` until a renderer subscribes, so the snapshot wait below
      // could never see them healthy without this subscription.
      await subscribeToDiagnostics(client)
      const snapshot = await waitForSnapshot(client)
      const serialized = JSON.stringify(snapshot)
      if (serialized.includes(SECRET_SENTINEL)) throw new Error("Packaged snapshot leaked the secret sentinel")
      const startupHistory =
        snapshot.markers.some(
          (marker) => marker.type === "lifecycle" && marker.event === "profiler-started",
        ) && snapshot.samples.some((sample) => sample.at < snapshot.capturedAt)
      if (!startupHistory) throw new Error("Packaged snapshot did not retain pre-open startup history")
      const sourceHealth = requirePackagedSourceHealth(snapshot, process.platform)
      const server = snapshot.owners.find((owner) => owner.kind === "server")
      if (
        !server ||
        !snapshot.processes.some((process) => process.ownerId === server.id && process.role === "server")
      ) {
        throw new Error("Packaged snapshot did not separate the Claxedo server utility process")
      }
      const contributor = snapshot.interval.contributors.find(
        (item) =>
          reading(item.peakCpuMachinePercent) > 0 ||
          byteReading(item.peakRssBytes) > 0,
      )
      const contributorOwner = snapshot.owners.find((owner) => owner.id === contributor?.ownerId)
      if (!contributorOwner) throw new Error("Packaged startup did not produce a measured contributor")
      const actionSafety = await packagedActionSafety(client, snapshot, server.id)
      const evidence: DiagnosticsSmokeEvidence = {
        mode: "packaged",
        platform: process.platform,
        architecture: process.arch,
        startupHistory,
        topContributor: contributorOwner.label,
        serverSeparated: true,
        memoryGrowth: snapshot.interval.contributors.some(
          (item) => byteReading(item.rssChangeBytes) > 0,
        ),
        churnUnmeasured: snapshot.markers.some(
          (marker) => marker.type === "churn" && marker.resourceMeasurement.state === "unmeasured",
        ),
        redacted: true,
        actionSafety,
        retainedBytes: serialized.length,
        sourceHealth,
      }
      if (evidence.retainedBytes > DIAGNOSTICS_RETAINED_BYTES_BUDGET) {
        throw new Error(
          `Packaged retained bytes ${String(evidence.retainedBytes)} exceeded ${String(DIAGNOSTICS_RETAINED_BYTES_BUDGET)}`,
        )
      }
      return evidence
    } finally {
      await client.evaluate(`window.api?.quit?.()`).catch(() => undefined)
      await Promise.race([application.exited, Bun.sleep(5_000)])
      client.close()
    }
  } finally {
    if (application.exitCode === null) application.kill()
    await Promise.race([application.exited, Bun.sleep(5_000)])
    await rm(userData, { recursive: true, force: true })
  }
}

async function packagedActionSafety(
  client: CdpClient,
  snapshot: LocalDiagnostics.RetainedSnapshot,
  serverOwnerId: string,
): Promise<DiagnosticsSmokeEvidence["actionSafety"]> {
  const invalidToken = "diagnostics-invalid-token-00000000"
  const first = await evaluateActionResult(
    client,
    `window.api.processDiagnostics.stop(${JSON.stringify({ action: "stop", token: invalidToken })})`,
  )
  const second = await evaluateActionResult(
    client,
    `window.api.processDiagnostics.stop(${JSON.stringify({ action: "stop", token: invalidToken })})`,
  )
  if (
    first.ok ||
    first.code !== "invalid-token" ||
    second.ok ||
    second.code !== "invalid-token"
  ) {
    throw new Error("Packaged diagnostics accepted an invalid opaque action token")
  }
  const serverProcesses = snapshot.processes.filter((process) => process.ownerId === serverOwnerId)
  if (
    serverProcesses.length === 0 ||
    serverProcesses.some((process) =>
      process.actionEligibility.state !== "ineligible" ||
      process.actionEligibility.reason !== "protected-process")
  ) {
    throw new Error("Packaged diagnostics exposed a destructive action for the protected Claxedo server")
  }
  if (process.platform === "darwin") {
    const fixtureProcesses = snapshot.processes.filter((process) =>
      process.ownerId === "diagnostics-packaged-stop" ||
      process.ownerId === "diagnostics-packaged-kill")
    if (
      fixtureProcesses.length < 2 ||
      fixtureProcesses.some((process) => process.actionEligibility.state === "eligible")
    ) {
      throw new Error("Packaged macOS diagnostics exposed an action without creation identity")
    }
    return "packaged-read-only"
  }
  const stop = actionGrant(snapshot, "diagnostics-packaged-stop", "stop")
  const stopped = await evaluateActionResult(
    client,
    `window.api.processDiagnostics.stop(${JSON.stringify({ action: "stop", token: stop.token })})`,
  )
  if (!stopped.ok) throw new Error(`Packaged owner-scoped Stop failed: ${stopped.code}`)
  const replayed = await evaluateActionResult(
    client,
    `window.api.processDiagnostics.stop(${JSON.stringify({ action: "stop", token: stop.token })})`,
  )
  if (replayed.ok || replayed.code !== "invalid-token") {
    throw new Error("Packaged owner-scoped Stop token was not single-use")
  }
  const afterStop = await evaluateSnapshot(client, `window.api.processDiagnostics.getSnapshot()`)
  const kill = actionGrant(afterStop, "diagnostics-packaged-kill", "kill")
  const killed = await evaluateActionResult(
    client,
    `window.api.processDiagnostics.kill(${JSON.stringify({ action: "kill", token: kill.token })})`,
  )
  if (!killed.ok) throw new Error(`Packaged owner-scoped Kill failed: ${killed.code}`)
  return "verified"
}

function actionGrant(
  snapshot: LocalDiagnostics.RetainedSnapshot,
  ownerId: string,
  action: LocalDiagnostics.ActionKind,
) {
  const process = snapshot.processes.find((candidate) =>
    candidate.ownerId === ownerId &&
    candidate.actionEligibility.state === "eligible" &&
    candidate.actionEligibility.actions.some((grant) => grant.action === action))
  if (!process || process.actionEligibility.state !== "eligible") {
    throw new Error(`Packaged diagnostics did not expose an identity-bound ${action} grant for ${ownerId}`)
  }
  const grant = process.actionEligibility.actions.find((candidate) => candidate.action === action)
  if (!grant) throw new Error(`Packaged diagnostics ${action} grant disappeared for ${ownerId}`)
  return grant
}

async function connectToPackagedApp(port: number, application: Bun.Subprocess) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (application.exitCode !== null) {
      throw new Error(`Packaged Claxedo exited before its renderer became reachable: ${String(application.exitCode)}`)
    }
    const targets = await fetch(`http://127.0.0.1:${String(port)}/json`, {
      signal: AbortSignal.timeout(2_000),
    })
      .then((response): Promise<unknown> => response.json())
      .catch(() => [])
    // Read, not asserted: `/json` is the browser's own inventory, and only
    // three of its fields matter here.
    const target = (Array.isArray(targets) ? targets : []).find(
      (item) => readString(item, "type") === "page" && readString(item, "url")?.includes("/out/renderer/index.local.html"),
    )
    const debuggerUrl = readString(target, "webSocketDebuggerUrl")
    if (debuggerUrl) return await createCdpClient(debuggerUrl)
    await Bun.sleep(250)
  }
  throw new Error("Packaged Claxedo DevTools endpoint did not become reachable")
}

async function waitForMainWindow(client: CdpClient) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const ready = await evaluateBoolean(
      client,
      `document.readyState === "complete" && typeof window.api?.processDiagnostics?.getSnapshot === "function"`,
    )
    if (ready) return
    await Bun.sleep(500)
  }
  throw new Error("Packaged Claxedo main window did not become ready")
}

async function requirePackagedMermaid(client: CdpClient) {
  const svg = await client.evaluate(`window.api.renderMermaid("flowchart LR\\n  A --> B")`)
  if (typeof svg !== "string" || !svg.startsWith("<svg")) {
    throw new Error("Packaged render-mermaid did not draw a flowchart as SVG")
  }
}

async function subscribeToDiagnostics(client: CdpClient) {
  const subscribed = await evaluateBoolean(
    client,
    `(() => { window.api.processDiagnostics.subscribe(() => {}); return true })()`,
  )
  if (!subscribed) throw new Error("Packaged renderer could not subscribe to diagnostics")
}

async function availablePort() {
  const server = createServer()
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve a diagnostics smoke debug port"))
        return
      }
      resolvePort(address.port)
    })
  })
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => error ? reject(error) : resolveClose()))
  return port
}

async function waitForSnapshot(client: CdpClient) {
  // 180s, not 60s: readiness requires the windows-cim source healthy, and the
  // CIM worker's measured cold start is 22–47s on the release runners (paid
  // once per app boot, overlapping it). Readiness needs a cold start PLUS the
  // second sample that CPU deltas require, and a failed first spawn puts a
  // retry's cold start on top of that — 120s could not fit two. The loop exits
  // as soon as the snapshot is ready; the deadline only bounds the failure path.
  const deadline = Date.now() + 180_000
  let last: LocalDiagnostics.RetainedSnapshot | undefined
  while (Date.now() < deadline) {
    const raw = await client.evaluate(`window.api?.processDiagnostics?.getSnapshot?.()`).catch(() => undefined)
    const snapshot = raw === undefined ? undefined : LocalDiagnostics.RetainedSnapshot.parse(raw)
    last = snapshot ?? last
    if (
      snapshot &&
      snapshot.samples.length > 1 &&
      snapshot.owners.some((owner) => owner.kind === "server") &&
      snapshot.processes.some((process) => process.ownerId === "diagnostics-packaged-stop") &&
      snapshot.processes.some((process) => process.ownerId === "diagnostics-packaged-kill") &&
      snapshot.interval.contributors.some((contributor) =>
        contributor.ownerId === "diagnostics-packaged-stop" &&
        byteReading(contributor.rssChangeBytes) > 0) &&
      snapshot.markers.some((marker) =>
        marker.type === "churn" &&
        marker.ownerId === "diagnostics-packaged-churn" &&
        marker.resourceMeasurement.state === "unmeasured") &&
      packagedSourcesReady(snapshot, process.platform)
    ) return snapshot
    await Bun.sleep(500)
  }
  throw new Error(
    `Packaged diagnostics snapshot did not become ready: ${JSON.stringify({
      samples: last?.samples.length ?? 0,
      owners: last?.owners.map((owner) => owner.kind) ?? [],
      sources: last?.sources.map((source) => ({
        source: source.source,
        state: source.state,
        ...("reason" in source ? { reason: source.reason } : {}),
      })) ?? [],
    })}`,
  )
}

/** The three answer shapes this smoke reads out of the packaged renderer. */
async function evaluateBoolean(client: CdpClient, expression: string): Promise<boolean> {
  return (await client.evaluate(expression).catch(() => false)) === true
}

async function evaluateActionResult(client: CdpClient, expression: string) {
  return LocalDiagnostics.ActionResult.parse(await client.evaluate(expression))
}

async function evaluateSnapshot(client: CdpClient, expression: string) {
  return LocalDiagnostics.RetainedSnapshot.parse(await client.evaluate(expression))
}

async function discoverPackagedExecutable() {
  const dist = resolve(import.meta.dirname, "../dist")
  const productName = process.env.CLAXEDO_CHANNEL === "prod" ? "Claxedo" : "Claxedo Dev"
  const output = process.arch === "arm64" ? "-arm64" : ""
  const candidates =
    process.platform === "darwin"
      ? [join(dist, `mac${output}`, `${productName}.app`, "Contents", "MacOS", productName)]
      : process.platform === "win32"
        ? [join(dist, `win${output}-unpacked`, `${productName}.exe`)]
        : // Single candidate by contract: electron-builder.config.ts pins
          // linux executableName to "claxedo" for every channel.
          [join(dist, `linux${output}-unpacked`, "claxedo")]
  for (const file of candidates) {
    if (await Bun.file(file).exists()) return file
  }
  throw new Error(`No native packaged Claxedo executable found: ${candidates.join(", ")}`)
}
