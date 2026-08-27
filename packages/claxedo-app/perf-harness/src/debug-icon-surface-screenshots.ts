// TEMP probe (read-only diagnosis): pixel evidence for the icon-primitive
// migration.
//
// It boots the same settled `workspace-interactions` page the floor probes use
// and clips a PNG of each chrome surface that the icon primitive appears on, in
// BOTH color schemes. Two runs against two builds produce two directories whose
// same-named files must be byte-identical if the migration changed no pixels;
// `debug-icon-screenshot-diff.ts` reports where they are not.
//
// Run:
//   cd packages/claxedo-app/perf-harness
//   CLAXEDO_PERF_SKIP_BUILD=1 CLAXEDO_PERF_MOCK_PORT=<baked> \
//     PROBE_SHOT_DIR=/tmp/shots-base bun src/debug-icon-surface-screenshots.ts
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { chromium, type Page } from "@playwright/test"

import { frameSamplingLaunchArgs } from "./frame-sampler"
import {
  fixtureFor,
  installMockApi,
  installSeedState,
  launchTo,
  monitorPage,
  openReviewSurface,
  sessionPath,
  startApp,
  stopApp,
  waitForTranscript,
} from "./browser-runner"
import { environmentProfile } from "./environment-profile"
import { settleBeforeNextInteraction } from "./isolated-interaction"
import { seedForScenario } from "./seed"

const SCENARIO = "workspace-interactions" as const
const OUT = process.env.PROBE_SHOT_DIR ?? "/tmp/claxedo-icon-shots"

/** The surfaces the migration has to leave alone, named by what a reader sees. */
const SURFACES: Array<{ name: string; selector: string }> = [
  { name: "sidebar", selector: "[data-testid='rail-sidebar-shell']" },
  { name: "sidebar-inner", selector: "[data-testid='rail-sidebar']" },
  { name: "global-navigation", selector: "[data-slot='global-navigation']" },
  { name: "workbench-header", selector: "[data-testid='workbench-shell-header']" },
  { name: "workbench-l2-header", selector: "[data-testid='workbench-l2-header']" },
  { name: "workspace-panel-l1-header", selector: "[data-testid='workspace-panel-l1-header']" },
  { name: "review-header-row", selector: "#review-panel" },
  { name: "workspace-panel", selector: "[data-testid='workspace-panel-shell']" },
  { name: "composer", selector: "[data-component='session-prompt-dock']" },
  { name: "composer-toolbar", selector: "[data-slot='composer-toolbar']" },
]

const shoot = async (page: Page, scheme: "light" | "dark") => {
  const dir = join(OUT, scheme)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, "full-page.png"), animations: "disabled", caret: "hide" })
  for (const surface of SURFACES) {
    const locator = page.locator(surface.selector).first()
    if ((await locator.count()) === 0) {
      console.log(`  ${scheme.padEnd(5)} ${surface.name.padEnd(26)} ABSENT (${surface.selector})`)
      continue
    }
    const box = await locator.boundingBox()
    if (!box || box.width < 1 || box.height < 1) {
      console.log(`  ${scheme.padEnd(5)} ${surface.name.padEnd(26)} ZERO-BOX`)
      continue
    }
    // Clip off a full-page shot rather than locator.screenshot: the composer
    // dock animates, and element screenshots block waiting for it to be stable.
    await page.screenshot({
      path: join(dir, `${surface.name}.png`),
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
      animations: "disabled",
      caret: "hide",
    })
    console.log(
      `  ${scheme.padEnd(5)} ${surface.name.padEnd(26)} ${Math.round(box.width)}x${Math.round(box.height)}` +
        ` @${Math.round(box.x)},${Math.round(box.y)}`,
    )
  }
}

for (const scheme of ["light", "dark"] as const) {
  const app = await startApp()
  const fixture = fixtureFor(SCENARIO, seedForScenario(SCENARIO))
  const browser = await chromium.launch({ headless: true, args: frameSamplingLaunchArgs, timeout: 30_000 })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: scheme })
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 300)))

  await installMockApi(page, app, fixture, monitorPage(page), environmentProfile("unthrottled"))
  await installSeedState(page, app, fixture)
  const session = fixture.sessions[0]!
  await launchTo(page, app, sessionPath(session, session.id))
  await waitForTranscript(page, fixture, session.id, session.title)
  await openReviewSurface(page, fixture, { settle: "frame" })
  await settleBeforeNextInteraction(page)
  // The composer dock mounts on engagement, so a run can reach the settle point
  // before it exists and silently skip the surface. Wait for it explicitly.
  await page
    .locator("[data-component='session-prompt-dock']")
    .first()
    .waitFor({ state: "attached", timeout: 15_000 })
    .catch(() => console.log("  [warn] composer dock never attached"))

  const counts = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? "<none>",
    scheme: getComputedStyle(document.documentElement).colorScheme,
    wrappers: document.querySelectorAll("div[data-component='icon']").length,
    flat: document.querySelectorAll("svg[data-component='icon']").length,
    elements: document.querySelectorAll("*").length,
  }))
  console.log(
    `\n[${scheme}] theme=${counts.theme} color-scheme=${counts.scheme}` +
      ` icons(div)=${counts.wrappers} icons(svg)=${counts.flat} elements=${counts.elements}`,
  )
  await shoot(page, scheme)

  await browser.close()
  await stopApp(app)
}

console.log(`\nwrote ${OUT}`)
