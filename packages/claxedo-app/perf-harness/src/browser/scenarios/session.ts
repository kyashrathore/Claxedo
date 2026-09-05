import { measurement } from "../../isolated-interaction"
import type { FlowResult } from "../../flows"
import {
  installPageLoadRecorder,
  stopPageLoadRecorder,
  performanceMetricDelta,
  measureInteraction,
  readPerformanceMetrics,
  readDomMutationSnapshot,
} from "../../frame-sampler"
import type { Measurement } from "../../types"
import { launchTo, settleForVideo } from "../actions/common"
import {
  waitForTranscript,
  waitForSessionComposer,
  showSessionInventory,
  measureInPageSessionFirstFoldSwitch,
} from "../actions/session"
import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import { sessionPath } from "../state"
import type { Page, BrowserContext } from "playwright-core"

export async function launchProject(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  await installPageLoadRecorder(page)
  const started = performance.now()
  const session = fixture.sessions[0]
  const launch = await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  await waitForSessionComposer(page)
  const transcriptReady = performance.now() - started
  await showSessionInventory(page, fixture, fixture.sessions.length, { settle: "frame" })
  const headline = await stopPageLoadRecorder(page, "launch-project", performance.now() - started)
  return {
    headline,
    debug: [
      measurement("launch_first_window_ms", launch.domContentLoaded),
      measurement("launch_workspace_ready_ms", launch.ready),
      measurement("transcript_render_ms", transcriptReady),
    ],
  }
}

export async function sessionSwitch(page: Page, app: BrowserTarget, fixture: ReturnType<typeof fixtureFor>): Promise<FlowResult> {
  const first = fixture.sessions[0]
  const second = fixture.sessions[1] ?? first
  const renderer = fixture.sessionRenderer
  const renderMermaid = process.env.CLAXEDO_PERF_MERMAID_EXPLICIT !== "0"
  await launchTo(page, app, sessionPath(first, first.id))
  await waitForTranscript(page, fixture, first.id, first.title)
  await showSessionInventory(page, fixture, Math.min(2, fixture.sessions.length))
  const prefetchSettleMs = Number(process.env.CLAXEDO_PERF_SESSION_PREFETCH_SETTLE_MS ?? "0")
  if (prefetchSettleMs > 0) await page.waitForTimeout(prefetchSettleMs)
  if (process.env.CLAXEDO_PERF_WARM_SESSION_SWITCH === "1") {
    await measureInPageSessionFirstFoldSwitch(page, second, { renderer, renderMermaid })
    await waitForTranscript(page, fixture, second.id, second.title)
    await measureInPageSessionFirstFoldSwitch(page, first, { renderer, renderMermaid })
    await waitForTranscript(page, fixture, first.id, first.title)
  }

  let singleSwitchMs = 0
  const perSwitchMetrics: Measurement[] = []
  const perSwitchCdp = process.env.CLAXEDO_PERF_PER_SWITCH === "1"
    ? await page.context().newCDPSession(page)
    : undefined
  await perSwitchCdp?.send("Performance.enable")

  const measuredSwitch = async (
    index: number,
    target: typeof first,
  ) => {
    const state = perSwitchCdp
      ? await page.locator(
          `[data-testid="session-page-root"][data-session-id="${target.id}"]`,
        ).count().then((count) => count > 0 ? "warm" : "cold")
      : undefined
    let before: Awaited<ReturnType<typeof readPerSwitchSnapshot>> | undefined
    let after: Awaited<ReturnType<typeof readPerSwitchSnapshot>> | undefined
    const elapsed = await measureInPageSessionFirstFoldSwitch(page, target, {
      renderer,
      renderMermaid,
      ...(perSwitchCdp
        ? {
            beforeClick: async () => {
              before = await readPerSwitchSnapshot(page, perSwitchCdp)
            },
            afterReady: async () => {
              after = await readPerSwitchSnapshot(page, perSwitchCdp)
            },
          }
        : {}),
    })
    if (before && after && state) {
      const performance = performanceMetricDelta(before.performance, after.performance)
      const prefix = `switch_${String(index).padStart(2, "0")}_${state}`
      const dom = before.dom && after.dom
        ? [
            measurement(`${prefix}_attribute_mutations`, after.dom.attributesChanged - before.dom.attributesChanged, "count"),
            measurement(`${prefix}_nodes_added`, after.dom.nodesAdded - before.dom.nodesAdded, "count"),
            measurement(`${prefix}_nodes_removed`, after.dom.nodesRemoved - before.dom.nodesRemoved, "count"),
          ]
        : []
      perSwitchMetrics.push(
        measurement(`${prefix}_completion_ms`, elapsed),
        measurement(`${prefix}_script_ms`, performance.scriptMs),
        measurement(`${prefix}_style_ms`, performance.recalcStyleMs),
        measurement(`${prefix}_layout_ms`, performance.layoutMs),
        measurement(`${prefix}_task_ms`, performance.taskMs),
        ...dom,
      )
    }
    return elapsed
  }
  // Headline: rapid back-and-forth switching between two sessions whose backing
  // histories contain 10k messages. Transcript readiness requires the loaded
  // first fold; the UI intentionally does not mount all 10k rows.
  // The frame recorder spans the whole stress loop; monitorPage simultaneously
  // catches any call-stack overflow / error-boundary as a validation failure.
  const headline = await measureInteraction(page, "session-switch", async () => {
    const rounds = Math.max(1, Number(process.env.CLAXEDO_PERF_SESSION_SWITCH_ROUNDS ?? "3"))
    for (let round = 0; round < rounds; round++) {
      const elapsed = await measuredSwitch(round * 2 + 1, second)
      if (round === 0) singleSwitchMs = elapsed
      await measuredSwitch(round * 2 + 2, first)
    }
  }).finally(() => perSwitchCdp?.detach())
  await waitForTranscript(page, fixture, first.id, first.title)
  await settleForVideo(page)
  return {
    headline,
    debug: [measurement("single_switch_ms", Math.round(singleSwitchMs * 100) / 100), ...perSwitchMetrics],
  }
}

async function readPerSwitchSnapshot(page: Page, cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>>) {
  const [performance, dom] = await Promise.all([
    readPerformanceMetrics(cdp),
    readDomMutationSnapshot(page),
  ])
  return { performance, dom }
}
