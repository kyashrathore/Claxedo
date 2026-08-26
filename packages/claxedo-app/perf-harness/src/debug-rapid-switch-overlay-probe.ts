// TEMP probe (read-only diagnosis): rapid successive session switches.
//
// Reproduces the user-reported flicker / content-shift / "incoming transcript
// overlaid on the previous session's still-painted transcript" by driving
// successive rail activations at ~80-150ms intervals (below the 40ms transcript
// join budget AND below the ~180ms `afterVisibleActivation` tail) and observing
// the DOM structurally, per animation frame.
//
// Anchoring: a capture-phase `pointerdown` listener installed in the page reads
// the clicked rail row's `data-session-id` and stamps it as the destination at
// the exact instant the trusted input lands — no Playwright-side latency in the
// window being measured.
//
// Per frame it records, for EVERY [data-testid='session-page-root']:
//   - data-session-id, data-session-message-count (skeleton vs real page)
//   - computed visibility / opacity / content-visibility, bounding rect
//   - the owning workbench slot's computed style + pane assignment
// plus `document.elementFromPoint` at the workbench canvas centre resolved up
// to its owning session root, and the rail's active-row set + first-row rect.
//
// It then reports, per switch:
//   - staleMs      how long the PREVIOUS session's root stayed the painted
//                  centre after pointerdown (the "previous session still
//                  painted" half of the report)
//   - overlapMs    frames where 2+ session roots painted overlapping rects
//   - skeletonMs   how long the destination showed its skeleton
//   - railShiftMs  frames where the rail's first row rect moved
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=46087 \
//     bun src/debug-rapid-switch-overlay-probe.ts
//
// The probe never touches application source; it only drives the built app.
import { chromium, type Locator } from "@playwright/test"

import { frameSamplingLaunchArgs } from "./frame-sampler"
import {
  fixtureFor,
  installMockApi,
  installSeedState,
  launchTo,
  monitorPage,
  sessionPath,
  startApp,
  stopApp,
  waitForTranscript,
} from "./browser-runner"
import { environmentProfile } from "./environment-profile"
import { seedForScenario } from "./seed"

const SCENARIO = "session-switch-workspace" as const
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 10)
const SWITCHES_PER_ROUND = Number(process.env.PROBE_SWITCHES ?? 4)
const CLICK_INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS ?? 110)
const SHOTS = process.env.PROBE_SHOTS === "1"
const SHOT_DIR = process.env.PROBE_SHOT_DIR ?? ".artifacts/overlay-probe"

const short = (id: string) => id.replace(/^ses_perf_session_switch_workspace_/, "s")

type PaintedRoot = {
  sessionId: string
  messageCount: string
  visibility: string
  opacity: string
  contentVisibility: string
  rect: { x: number; y: number; w: number; h: number }
  slotHasPane: boolean
  slotVisibility: string
  slotOpacity: string
  slotContentVisibility: string
  slotDisplay: string
  slotInert: boolean
}

type FrameRecord = {
  t: number
  painting: PaintedRoot[]
  hit: string | null
  overlap: string | null
  railActive: string[]
  railFirstRect: { y: number; h: number } | null
  railRowCount: number
  rowOverlap: string | null
  liveSlots: string[]
  assignedSlots: number
  slotCount: number
  paneCount: number
}

type ClickRecord = { t: number; sessionId: string }

type ShiftRecord = {
  t: number
  value: number
  hadRecentInput: boolean
  sources: Array<{ node: string; from: { y: number; h: number }; to: { y: number; h: number } }>
}

const app = await startApp()
const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
page.on("pageerror", (error) => console.log("[pageerror]", (error.stack ?? String(error)).slice(0, 1200)))
page.on("console", (message) => {
  if (message.type() === "error") console.log("[console error]", message.text().slice(0, 300))
})

await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
await installSeedState(page, app, fixture)

const sessions = fixture.sessions
const home = sessions[0]!
console.log(`[probe] app=${app.baseUrl} mock=${app.mockPort} sessions=${sessions.length}`)

await launchTo(page, app, sessionPath(home, home.id))
await waitForTranscript(page, fixture, home.id, home.title)
console.log("[probe] home session ready")

if (process.env.PROBE_PANEL === "open") {
  const toggle = page.locator("[data-testid='workspace-panel-toggle']").first()
  if (await toggle.count()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click({ timeout: 5_000 })
    await page.waitForTimeout(1_200)
    console.log("[probe] workspace panel opened")
  } else {
    console.log("[probe] workspace panel toggle NOT FOUND")
  }
}

const sessionRowActivate = async (target: (typeof sessions)[number]): Promise<Locator> => {
  const row = page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${target.id}"]`).first()
  if (await row.count()) {
    const activate = row.locator('[data-slot="navigation-row-activate"]').first()
    return (await activate.count()) ? activate : row
  }
  return page.locator("[role='button'], button, a").filter({ hasText: target.title }).first()
}

await page.evaluate(() => {
  type Probe = {
    frames: unknown[]
    clicks: unknown[]
    running: boolean
    start: () => void
    stop: () => void
  }
  const w = window as unknown as { __overlayProbe?: Probe }
  if (w.__overlayProbe) return
  const state: Probe = {
    frames: [],
    clicks: [],
    running: false,
    start() {
      state.frames = []
      state.clicks = []
      shifts.length = 0
      longTasks.length = 0
      state.running = true
      requestAnimationFrame(tick)
    },
    stop() {
      state.running = false
    },
  }
  const shifts: Array<Record<string, unknown>> = []
  const longTasks: Array<{ t: number; d: number }> = []
  try {
    new PerformanceObserver((list) => {
      if (!state.running) return
      for (const raw of list.getEntries()) {
        const entry = raw as unknown as {
          startTime: number
          value: number
          hadRecentInput: boolean
          sources?: Array<{ node?: Element; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>
        }
        shifts.push({
          t: entry.startTime,
          value: entry.value,
          hadRecentInput: entry.hadRecentInput,
          sources: (entry.sources ?? []).map((source) => {
            const node = source.node as HTMLElement | undefined
            const label = (element: HTMLElement): string => {
              const testid = element.getAttribute?.("data-testid")
              const slot = element.getAttribute?.("data-slot")
              const part = element.getAttribute?.("data-part-type") ?? element.getAttribute?.("data-message-role")
              const key = testid ?? slot ?? part
              if (key) return `${element.tagName.toLowerCase()}[${key}]`
              const cls = (element.className?.toString?.() ?? "").trim().split(/\s+/).slice(0, 3).join(".")
              return `${element.tagName.toLowerCase()}${cls ? "." + cls : ""}`
            }
            const describe = (element: HTMLElement | null | undefined): string => {
              if (!element) return "(detached)"
              const chain: string[] = []
              let cursor: HTMLElement | null = element
              for (let depth = 0; cursor && depth < 7; depth++) {
                chain.unshift(label(cursor))
                cursor = cursor.parentElement
              }
              const root = element.closest?.("[data-testid='session-page-root']")
              const owner = root?.getAttribute("data-session-id") ?? "(none)"
              const timeline = element.closest?.("[data-session-timeline-session-id]")
              const timelineOwner = timeline?.getAttribute("data-session-timeline-session-id") ?? ""
              const slotEl = element.closest?.("[data-workbench-content]")
              const slotVisible = slotEl ? getComputedStyle(slotEl).visibility : "n/a"
              return `owner=${owner}${timelineOwner ? ` timeline=${timelineOwner}` : ""} slotVis=${slotVisible} :: ${chain.join(" > ")}`
            }
            return {
              node: describe(node),
              from: { y: source.previousRect.y, h: source.previousRect.height },
              to: { y: source.currentRect.y, h: source.currentRect.height },
            }
          }),
        })
      }
    }).observe({ type: "layout-shift", buffered: false })
  } catch {}
  try {
    new PerformanceObserver((list) => {
      if (!state.running) return
      for (const entry of list.getEntries()) longTasks.push({ t: entry.startTime, d: entry.duration })
    }).observe({ type: "longtask", buffered: false })
  } catch {}
  ;(state as unknown as Record<string, unknown>).shifts = shifts
  ;(state as unknown as Record<string, unknown>).longTasks = longTasks
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!state.running) return
      const target = event.target as Element | null
      const row = target?.closest?.<HTMLElement>("[data-testid='rail-sidebar-session-row']")
      if (!row) return
      state.clicks.push({ t: performance.now(), sessionId: row.getAttribute("data-session-id") ?? "" })
    },
    true,
  )
  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  const tick = () => {
    if (!state.running) return
    const t = performance.now()
    const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-testid='session-page-root']"))
    const painting: Array<Record<string, unknown>> = []
    for (const root of roots) {
      const style = getComputedStyle(root)
      const rect = root.getBoundingClientRect()
      const area = rect.width * rect.height
      const slot = root.closest<HTMLElement>("[data-workbench-content]")
      const slotStyle = slot ? getComputedStyle(slot) : undefined
      const isPainting =
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity) > 0.01 &&
        area > 20_000 &&
        (!slotStyle || (slotStyle.visibility !== "hidden" && Number(slotStyle.opacity) > 0.01))
      if (!isPainting) continue
      painting.push({
        sessionId: root.getAttribute("data-session-id") ?? "",
        messageCount: root.getAttribute("data-session-message-count") ?? "",
        visibility: style.visibility,
        opacity: style.opacity,
        contentVisibility: (style as unknown as Record<string, string>).contentVisibility ?? "",
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        slotHasPane: !!slot?.getAttribute("data-pane-id"),
        slotVisibility: slotStyle?.visibility ?? "",
        slotOpacity: slotStyle?.opacity ?? "",
        slotContentVisibility: slotStyle
          ? ((slotStyle as unknown as Record<string, string>).contentVisibility ?? "")
          : "",
        slotDisplay: slotStyle?.display ?? "",
        slotInert: !!slot?.hasAttribute("inert"),
      })
    }
    // DIRECT structural test of the promote/stash race, independent of whether
    // a session root happens to be painted: how many workbench content slots
    // are simultaneously NOT suppressed (no visibility:hidden, no
    // content-visibility:hidden, opacity > 0). With one pane this must be
    // exactly 1 in every frame; 2+ is the overlay window.
    const slots = Array.from(document.querySelectorAll<HTMLElement>("[data-workbench-content]"))
    const liveSlots: string[] = []
    let assignedSlots = 0
    for (const slot of slots) {
      const style = getComputedStyle(slot)
      const cv = (style as unknown as Record<string, string>).contentVisibility ?? ""
      if (slot.getAttribute("data-pane-id")) assignedSlots += 1
      if (style.visibility === "hidden") continue
      if (cv === "hidden") continue
      if (style.display === "none") continue
      if (Number(style.opacity) <= 0.01) continue
      liveSlots.push(slot.getAttribute("data-workbench-content") ?? "?")
    }
    // Intra-transcript overlap: inside the ONE visible timeline, do any two
    // sibling message rows paint over each other? This is the "two transcripts
    // stacked" symptom expressed within a single session root, which the
    // cross-slot check above cannot see.
    let rowOverlap: string | null = null
    const liveTimeline = Array.from(
      document.querySelectorAll<HTMLElement>("[data-session-timeline-session-id]"),
    ).find((node) => {
      const style = getComputedStyle(node)
      return style.visibility !== "hidden" && node.getBoundingClientRect().height > 100
    })
    if (liveTimeline) {
      // `data-timeline-row` is the transcript's real row marker (message-
      // timeline.tsx:1382). `data-message-id` is NOT: it lives on the 100
      // 12px tick buttons of the message-nav gutter, which are a separate
      // column and legitimately overlap the transcript's x-range.
      // `data-timeline-row` is the transcript's real row marker (message-
      // timeline.tsx:1382). Only ON-SCREEN, NON-NESTED sibling pairs count: a
      // row scrolled above the viewport that overlaps its neighbour is not
      // something the user can see, and a row nested inside another row
      // overlaps its ancestor by construction.
      const all = Array.from(liveTimeline.querySelectorAll<HTMLElement>("[data-timeline-row]"))
        .filter((row) => row.getAttribute("data-timeline-row") !== "bottom-spacer")
      const rows = all.filter((row) => !all.some((other) => other !== row && other.contains(row)))
      const viewport = liveTimeline.getBoundingClientRect()
      const boxes = rows
        .map((row) => ({ id: row.getAttribute("data-timeline-row") ?? "?", node: row, r: row.getBoundingClientRect() }))
        .filter((entry) => entry.r.height > 4 && entry.r.bottom > viewport.top && entry.r.top < viewport.bottom)
        .sort((a, b) => a.r.top - b.r.top)
      for (let i = 0; i < boxes.length - 1 && !rowOverlap; i++) {
        const a = boxes[i]!
        const b = boxes[i + 1]!
        const by = a.r.bottom - b.r.top
        if (by > 1) rowOverlap = `${a.id}@${a.r.top.toFixed(0)}/${b.id}@${b.r.top.toFixed(0)} by ${by.toFixed(0)}px`
      }
    }
    const canvas = document.querySelector<HTMLElement>("[data-testid='workbench-root']")
    let hit: string | null = null
    if (canvas) {
      const box = canvas.getBoundingClientRect()
      const el = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      const hitRoot = el?.closest<HTMLElement>("[data-testid='session-page-root']")
      hit = hitRoot ? (hitRoot.getAttribute("data-session-id") ?? "") : null
    }
    let overlap: string | null = null
    for (let i = 0; i < painting.length && !overlap; i++) {
      for (let j = i + 1; j < painting.length; j++) {
        const a = painting[i] as PaintedLike
        const b = painting[j] as PaintedLike
        if (a.sessionId === b.sessionId) continue
        if (overlaps(a.rect, b.rect)) {
          overlap = `${a.sessionId}|${b.sessionId}`
          break
        }
      }
    }
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>("[data-testid='rail-sidebar-session-row']"),
    )
    const railActive = rows
      .filter((row) => row.getAttribute("data-active") === "true" || row.getAttribute("aria-current") === "true" || row.dataset.state === "active")
      .map((row) => row.getAttribute("data-session-id") ?? "")
    const firstRect = rows[0]?.getBoundingClientRect()
    state.frames.push({
      t,
      painting,
      hit,
      overlap,
      rowOverlap,
      liveSlots,
      assignedSlots,
      slotCount: slots.length,
      paneCount: document.querySelectorAll("[data-pane-id][data-testid^='pane-']").length,
      railActive,
      railFirstRect: firstRect ? { y: firstRect.y, h: firstRect.height } : null,
      railRowCount: rows.length,
    })
    requestAnimationFrame(tick)
  }
  type PaintedLike = { rect: { x: number; y: number; w: number; h: number }; sessionId: string }
  ;(window as unknown as { __overlayProbe: Probe }).__overlayProbe = state
})

type RoundResult = {
  round: number
  order: string[]
  frames: FrameRecord[]
  clicks: ClickRecord[]
  shifts: ShiftRecord[]
  longTasks: Array<{ t: number; d: number }>
}

const results: RoundResult[] = []

for (let round = 0; round < ROUNDS; round++) {
  const chain: typeof sessions = []
  for (let i = 0; i < SWITCHES_PER_ROUND; i++) {
    chain.push(sessions[(round * 3 + i + 1) % sessions.length]!)
  }
  await page.evaluate(() => {
    ;(window as unknown as { __overlayProbe: { start: () => void } }).__overlayProbe.start()
  })
  for (const target of chain) {
    const control = await sessionRowActivate(target)
    await control.click({ timeout: 5_000, force: true, noWaitAfter: true }).catch(() => undefined)
    await page.waitForTimeout(CLICK_INTERVAL_MS)
  }
  await page.waitForTimeout(700)
  const captured = (await page.evaluate(() => {
    const probe = (window as unknown as {
      __overlayProbe: { stop: () => void; frames: unknown[]; clicks: unknown[]; shifts: unknown[]; longTasks: unknown[] }
    }).__overlayProbe
    probe.stop()
    return {
      frames: probe.frames,
      clicks: probe.clicks,
      shifts: (probe as unknown as { shifts: unknown[] }).shifts.slice(),
      longTasks: (probe as unknown as { longTasks: unknown[] }).longTasks.slice(),
    }
  })) as { frames: FrameRecord[]; clicks: ClickRecord[]; shifts: ShiftRecord[]; longTasks: Array<{ t: number; d: number }> }
  results.push({
    round,
    order: chain.map((s) => s.id),
    frames: captured.frames,
    clicks: captured.clicks,
    shifts: captured.shifts,
    longTasks: captured.longTasks,
  })

  // --- per-switch report
  console.log("")
  console.log(`[round ${round}] chain=${chain.map((s) => short(s.id)).join(" -> ")} frames=${captured.frames.length} clicks=${captured.clicks.length}`)
  const overlapFrames = captured.frames.filter((f) => f.overlap)
  const multiPaint = captured.frames.filter((f) => new Set(f.painting.map((p) => p.sessionId)).size > 1)
  const multiLive = captured.frames.filter((f) => f.liveSlots.length > 1)
  const multiAssigned = captured.frames.filter((f) => f.assignedSlots > f.paneCount)
  console.log(`  overlap frames=${overlapFrames.length}  multi-session-painting frames=${multiPaint.length}`)
  console.log(`  slots=${captured.frames.at(-1)?.slotCount ?? 0} panes=${captured.frames.at(-1)?.paneCount ?? 0} ` +
    `frames with >1 UNSUPPRESSED slot=${multiLive.length}  frames with assigned>panes=${multiAssigned.length}`)
  const rowOverlaps = captured.frames.filter((f) => f.rowOverlap)
  console.log(`  frames with overlapping message rows inside one timeline=${rowOverlaps.length}` +
    (rowOverlaps.length ? ` first=${rowOverlaps[0]!.rowOverlap}` : ""))
  if (multiLive.length) {
    const worst = multiLive[0]!
    console.log(`  !! ${worst.liveSlots.length} unsuppressed slots at t=${worst.t.toFixed(1)}: ${worst.liveSlots.join(", ")}`)
  }
  for (let c = 0; c < captured.clicks.length; c++) {
    const click = captured.clicks[c]!
    const nextClick = captured.clicks[c + 1]?.t ?? click.t + 1_500
    const window = captured.frames.filter((f) => f.t >= click.t && f.t < nextClick)
    if (!window.length) continue
    const previous = captured.frames.filter((f) => f.t < click.t).at(-1)
    const priorHit = previous?.hit ?? null
    const staleFrames = window.filter((f) => f.hit && f.hit !== click.sessionId)
    const staleMs = staleFrames.length ? staleFrames.at(-1)!.t - click.t : 0
    const firstDest = window.find((f) => f.hit === click.sessionId)
    const destMs = firstDest ? firstDest.t - click.t : -1
    const skeletonFrames = window.filter((f) =>
      f.hit === click.sessionId && f.painting.some((p) => p.sessionId === click.sessionId && p.messageCount === "0"))
    const skeletonMs = skeletonFrames.length ? skeletonFrames.at(-1)!.t - skeletonFrames[0]!.t : 0
    const railMoves = window.filter((f, i) => {
      const prev = i === 0 ? previous : window[i - 1]
      return !!prev?.railFirstRect && !!f.railFirstRect && Math.abs(prev.railFirstRect.y - f.railFirstRect.y) > 0.5
    })
    const railCountChanges = new Set(window.map((f) => f.railRowCount)).size
    const activeChurn = new Set(window.map((f) => f.railActive.join(","))).size
    console.log(
      `  click#${c} -> ${short(click.sessionId)} (from ${priorHit ? short(priorHit) : "?"}): ` +
      `staleMs=${staleMs.toFixed(1)} destPaintedAt=${destMs.toFixed(1)}ms skeletonMs=${skeletonMs.toFixed(1)} ` +
      `railRowMoves=${railMoves.length} railRowCounts=${railCountChanges} activeSetVariants=${activeChurn} ` +
      `overlapInWindow=${window.filter((f) => f.overlap).length}`,
    )
  }
  const cls = captured.shifts.reduce((sum, entry) => sum + entry.value, 0)
  console.log(`  layout-shift entries=${captured.shifts.length} total=${cls.toFixed(4)}  longtasks=${captured.longTasks.length} maxTask=${Math.max(0, ...captured.longTasks.map((task) => task.d)).toFixed(0)}ms`)
  const bySource = new Map<string, { count: number; value: number }>()
  for (const entry of captured.shifts) {
    for (const source of entry.sources) {
      const seen = bySource.get(source.node) ?? { count: 0, value: 0 }
      seen.count += 1
      seen.value += entry.value / Math.max(1, entry.sources.length)
      bySource.set(source.node, seen)
    }
  }
  for (const [node, seen] of [...bySource].sort((a, b) => b[1].value - a[1].value).slice(0, 6)) {
    console.log(`    shift source x${seen.count} val=${seen.value.toFixed(4)}  ${node}`)
  }
  if (overlapFrames.length) {
    const first = overlapFrames[0]!
    console.log(`  !! OVERLAP reason=${first.overlap}`)
    for (const p of first.painting) {
      console.log(
        `     session=${short(p.sessionId)} msgs=${p.messageCount} vis=${p.visibility} op=${p.opacity} cv=${p.contentVisibility} ` +
        `rect=${Math.round(p.rect.x)},${Math.round(p.rect.y)} ${Math.round(p.rect.w)}x${Math.round(p.rect.h)} pane=${p.slotHasPane} ` +
        `slot[vis=${p.slotVisibility} op=${p.slotOpacity} cv=${p.slotContentVisibility} disp=${p.slotDisplay} inert=${p.slotInert}]`,
      )
    }
    if (SHOTS) await page.screenshot({ path: `${SHOT_DIR}/round-${round}-overlap.png` }).catch(() => undefined)
  }
  await page.waitForTimeout(400)
}

console.log("")
console.log("=== RAPID-SWITCH SUMMARY ===")
console.log(`rounds=${ROUNDS} switches/round=${SWITCHES_PER_ROUND} interval=${CLICK_INTERVAL_MS}ms`)
const allFrames = results.flatMap((r) => r.frames)
console.log(`frames sampled: ${allFrames.length}`)
console.log(`overlap frames: ${allFrames.filter((f) => f.overlap).length}`)
console.log(`multi-session painting frames: ${allFrames.filter((f) => new Set(f.painting.map((p) => p.sessionId)).size > 1).length}`)

if (process.env.PROBE_JSON) {
  await Bun.write(process.env.PROBE_JSON, JSON.stringify(results, null, 2))
  console.log(`[probe] wrote ${process.env.PROBE_JSON}`)
}

await browser.close()
await stopApp(app)
