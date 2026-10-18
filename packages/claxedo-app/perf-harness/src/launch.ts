import { openSync, closeSync } from "node:fs"
import { requireBenchmarkWindow, requireVisibleFocusedWindow, windowArguments } from "./app-window"
import { connectCdpPage, type CdpPage } from "./cdp-page"
import type { ReadinessTarget } from "./corpus"
import type { FrameLog, PageSettle } from "./driver-sdk"
import { freePort } from "@claxedo/helpers/net"
import type { PackagedApp } from "./packaged-app"
import { ProcessFamily, readProcessTable, type ProcessRow } from "./process-family"
import { revealSessionRow, trustedClick, type RevealScope } from "./rail"
import { appStartReadiness, readPageSettle, sessionActivation, settleExpressionFor, type Activation } from "./settle"
import { stopProcessFamily, type OwnedProcess } from "./shutdown"
import { isolatedEnvironment, statePaths } from "./state-root"

export type AppLaunch = {
  root: OwnedProcess
  page: CdpPage
  spawnAtMs: number
  readyAtMs: number
  readyFrameLog: FrameLog
  activate(target: ReadinessTarget, scope: RevealScope): Promise<Activation>
  shutdown(): Promise<{ terminated: OwnedProcess[]; survivors: OwnedProcess[] }>
}

export type LaunchInput = {
  app: PackagedApp
  stateRoot: string
  control: ReadinessTarget
  controlScope: RevealScope
  log: (line: string) => void
}

const CONNECT_TIMEOUT_MS = 60_000
const READINESS_TIMEOUT_MS = 30_000
const START_TIMEOUT_MS = 60_000

async function waitForShell(page: CdpPage) {
  await page.waitFor(
    () => !!document.querySelector('[data-surface="sidebar"] [data-slot="session-navigation-row"]'),
    undefined,
    CONNECT_TIMEOUT_MS,
    "its session rail",
  )
}

function armSettle(page: CdpPage, target: ReadinessTarget, timeoutMs: number, start: "now" | "trusted-pointerdown") {
  const armed = page.evaluateExpression(settleExpressionFor(target, timeoutMs, start)).then(readPageSettle)
  void armed.catch(() => undefined)
  return armed
}

async function openAtStart(page: CdpPage, target: ReadinessTarget, scope: RevealScope) {
  const armed = armSettle(page, target, START_TIMEOUT_MS, "now")
  await trustedClick(page, await revealSessionRow(page, target, scope, START_TIMEOUT_MS))
  return armed
}

async function openBySwitch(page: CdpPage, target: ReadinessTarget, scope: RevealScope) {
  await requireVisibleFocusedWindow(page)
  const point = await revealSessionRow(page, target, scope, READINESS_TIMEOUT_MS)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const armed = armSettle(page, target, READINESS_TIMEOUT_MS, "trusted-pointerdown")
  await page.evaluate(() => true)
  await trustedClick(page, point)
  return armed
}

async function ownedRoot(pid: number): Promise<ProcessRow> {
  const root = (await readProcessTable()).find((row) => row.pid === pid)
  if (!root) throw new Error(`Claxedo's main process ${String(pid)} is not in the process table`)
  return root
}

function ownedProcess(row: ProcessRow, rootPid: number): OwnedProcess {
  return { pid: row.pid, startTimeMs: row.startTimeMs, owner: "application", category: row.pid === rootPid ? "claxedo-main" : "claxedo-descendant" }
}

function spawnApp(input: LaunchInput, port: number) {
  const paths = statePaths(input.stateRoot)
  const log = openSync(paths.appLog, "a")
  const child = Bun.spawn({
    cmd: [input.app.executable, `--remote-debugging-port=${String(port)}`, ...windowArguments()],
    cwd: paths.home,
    env: isolatedEnvironment(input.stateRoot),
    stdout: log,
    stderr: log,
  })
  closeSync(log)
  return child
}

type Started = { application: ReturnType<typeof spawnApp>; page: CdpPage; family: ProcessFamily; spawnAtMs: number; settle: PageSettle }

async function startedLaunch(input: LaunchInput, started: Started): Promise<AppLaunch> {
  const { application, page, family, spawnAtMs } = started
  const { readyAtMs, readyFrameLog } = appStartReadiness(started.settle, spawnAtMs, performance.timeOrigin)
  const window = await requireBenchmarkWindow(page)
  const refresh = async () => family.observe(await readProcessTable())
  await refresh()
  const tracking = setInterval(() => void refresh().catch((error) => input.log(`process refresh failed: ${String(error)}`)), 250)
  tracking.unref()
  input.log(`launched ${input.control.logicalSessionId}: ready ${(readyAtMs - spawnAtMs).toFixed(0)} ms after spawn, window ${JSON.stringify(window)}`)
  return {
    root: { ...ownedProcess(family.root, application.pid), role: "main" },
    page,
    spawnAtMs,
    readyAtMs,
    readyFrameLog,
    async activate(target, scope) {
      const result = await openBySwitch(page, target, scope)
      input.log(`activated ${target.logicalSessionId}: ${(result.settledAt - result.startAt).toFixed(1)} ms`)
      return sessionActivation(result)
    },
    async shutdown() {
      clearInterval(tracking)
      const stopped = await stopProcessFamily({ application, family, page })
      return {
        terminated: stopped.terminated.map((row) => ownedProcess(row, application.pid)),
        survivors: stopped.survivors.map((row) => ownedProcess(row, application.pid)),
      }
    },
  }
}

export async function launchClaxedo(input: LaunchInput): Promise<AppLaunch> {
  const port = await freePort()
  const spawnAtMs = performance.now()
  const application = spawnApp(input, port)
  let family: ProcessFamily | undefined
  let page: CdpPage | undefined
  try {
    page = await connectCdpPage({ port, alive: () => application.exitCode === null, timeoutMs: CONNECT_TIMEOUT_MS })
    family = new ProcessFamily(await ownedRoot(application.pid))
    await waitForShell(page)
    const settle = await openAtStart(page, input.control, input.controlScope)
    return await startedLaunch(input, { application, page, family, spawnAtMs, settle })
  } catch (error) {
    page?.close()
    if (family) await stopProcessFamily({ application, family, page: undefined })
    else application.kill("SIGKILL")
    throw error
  }
}
