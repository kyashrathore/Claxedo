import { apiRequests, expect, expectNothingAnimating, sessionRoute, test, UI, UNTRACED } from "../harness"
import { installPaintedFrames } from "../harness/painted-frames"
import { recordSwitchFrames, switchReport, type SwitchReport } from "./12-switch-paint.frames"
import { seedTurns } from "./12-switch-paint.seed"

test.skip(({ isMobile }) => isMobile, "flow 12 runs at desktop width; flow 33 covers the phone")
test.use(UNTRACED)

type RowHeightsWindow = Window & { __claxedoFixedRowHeights?: Record<string, string[]> }

test("12 a switch lays out every turn gap and turn fold at its drawn height from the frame it mounts", async ({ stack, api, app }) => {
  const here = await stack.daemon.makeWorkspace("rows", "Rows")
  const previous = await seedTurns(stack, api, here.directory, "Previous", 1)
  const target = await seedTurns(stack, api, here.directory, "Target", 6)
  await app.goto(`${stack.url}${sessionRoute(here.id, previous.id)}`)
  await expect(app.getByText("Previous reply line 6.").first()).toBeVisible()
  await app.evaluate(() => {
    const heights: Record<string, string[]> = {}
    const note = (row: HTMLElement, style = row.getAttribute("style") ?? "") => {
      const key = row.dataset.timelineKey
      if (!key?.startsWith("turn-gap:") && !key?.startsWith("turn-fold:")) return
      const height = /(?:^|;)\s*height:\s*([^;]+)/.exec(style)?.[1]?.trim() ?? "none"
      const seen = (heights[key] ??= [])
      if (!seen.includes(height)) seen.push(height)
    }
    ;(window as RowHeightsWindow).__claxedoFixedRowHeights = heights
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof HTMLElement) note(record.target, record.oldValue ?? "")
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) [node, ...node.querySelectorAll<HTMLElement>("[data-timeline-key]")].forEach((row) => note(row))
        }
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["style"] })
  })
  await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: target.title, exact: true }).click()
  await expect(app.getByText("Target reply line 6.").last()).toBeVisible()
  await expectNothingAnimating(app)

  const rows = await app.evaluate(() =>
    Object.entries((window as RowHeightsWindow).__claxedoFixedRowHeights ?? {}).map(([key, heights]) => {
      const drawn = document.querySelector<HTMLElement>(`[data-timeline-key="${key}"] > [data-index]`)
      return drawn ? [{ key: key.split(":")[0], heights, drawn: `${drawn.getBoundingClientRect().height}px` }] : []
    }).flat(),
  )
  expect(new Set(rows.map((row) => row.key)), "row kinds still mounted after the switch").toEqual(new Set(["turn-gap", "turn-fold"]))
  expect(rows.filter((row) => row.heights.some((height) => height !== row.drawn))).toEqual([])
})

test("12 a session switch shows the previous session until the next one is laid out in its final place, and nothing between", async ({ stack, api, app }, info) => {
  const here = await stack.daemon.makeWorkspace("paint", "Paint")
  const there = await stack.daemon.makeWorkspace("elsewhere", "Elsewhere")
  const previous = await seedTurns(stack, api, here.directory, "Previous", 2)
  const target = await seedTurns(stack, api, here.directory, "Target", 12)
  const elsewhere = await seedTurns(stack, api, there.directory, "Elsewhere", 12)
  const long = await seedTurns(stack, api, here.directory, "Long", 30, { lines: 40 })
  const failed = await seedTurns(stack, api, here.directory, "Failed", 12, { lastFails: true })
  const short = await seedTurns(stack, api, there.directory, "Short", 4)
  const pi = await api.createSession(here.directory, { title: "Pi", harness: { id: "pi", access: "native" }, model: { providerId: "pi", modelId: "openai/gpt-4.1" } })
  await api.prompt(here.directory, pi.id, "Pi turn: review the fixture.")
  await app.addInitScript(installPaintedFrames)
  await app.goto(`${stack.url}${sessionRoute(here.id, previous.id)}`)
  await expect(app.getByText("Previous reply line 6.").first()).toBeVisible()
  const settled = apiRequests(app, stack.url)
  await settled()

  const acp = { model: "Scripted ACP default", nameKnown: true }
  const switches = [
    { label: "unvisited", next: target, nav: true, ...acp },
    { label: "unvisited Pi", next: pi, nav: false, model: "openai/gpt-4.1", nameKnown: false },
    { label: "another workspace", next: elsewhere, nav: true, ...acp },
    { label: "short unvisited", next: short, nav: false, ...acp },
    { label: "long rows", next: long, nav: true, ...acp },
    { label: "failed last turn", next: failed, nav: true, ...acp },
    { label: "visited", next: previous, nav: false, ...acp },
  ]
  for (const { label, next, nav, model, nameKnown } of switches) {
    await test.step(`switch to the ${label} session`, async () => {
      const frames = await recordSwitchFrames(app, { targetId: next.id, quietFrames: 30 })
      await app.getByRole("navigation", { name: UI.rail }).getByRole("button", { name: next.title, exact: true }).click()
      const seen = switchReport(await frames(), next.id)
      const reads = await settled()
      const timing = (name: string, point: SwitchReport["revealedAt"]) => `${name} +${point?.ms}ms, frame ${point?.frame}`
      await info.attach(`${label} switch`, { body: [...seen.states, "", timing("revealed", seen.revealedAt), timing("settled", seen.settledAt), ...reads].join("\n"), contentType: "text/plain" })
      expect.soft(seen.empty, "frames with an empty, loading or missing session body").toEqual([])
      expect.soft(seen.overlaid, "frames painting two sessions at once").toEqual([])
      expect.soft(seen.moved, `frames where a painted row of the ${label} session moved, or a row of its first frame went away`).toEqual([])
      expect.soft(seen.shownStates.length, `visible states of the ${label} session from its reveal to its settle:\n${seen.shownStates.join("\n")}`).toBeLessThanOrEqual(2)
      if (nameKnown) expect.soft(seen.footers, `composer footer labels of the ${label} session`).toHaveLength(1)
      expect.soft(seen.footers[0], `the ${label} session's first footer names its model`).toContain(model)
      expect.soft(seen.footers[0], `the ${label} session's first footer`).not.toMatch(/Select (model|agent)/)
      expect.soft(seen.navs, `the ${label} session's nav rail in every frame from its reveal`).toEqual([nav])
      expect.soft(seen.railApart, "frames where the rail selects a session other than the one shown").toEqual([])
      expect.soft(seen.sessions, "sessions shown, in order").toEqual(seen.sessions.length === 1 ? [next.id] : [seen.sessions[0], next.id])
      await expectNothingAnimating(app)
    })
  }
})
