import { isBoolean, isFiniteNumber, isRecord } from "@claxedo/helpers/guards"
import type { CdpPage } from "./cdp-page"

export const VIEWPORT = { width: 1512, height: 875, deviceScaleFactor: 2 }

const LINUX_MENU_BAR_CSS_PX = 27

export function windowArguments() {
  return [
    `--force-device-scale-factor=${String(VIEWPORT.deviceScaleFactor)}`,
    "--force-dark-mode",
    "--claxedo-window-maximized",
    ...(process.platform === "linux" ? [`--claxedo-window-size=${String(VIEWPORT.width)},${String(VIEWPORT.height + LINUX_MENU_BAR_CSS_PX)}`] : []),
    ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
  ]
}

type WindowFacts = { width: number; height: number; scale: number; dark: boolean; visible: boolean; focused: boolean; screenX: number; screenY: number }

const WINDOW_MEASURES = ["width", "height", "scale", "screenX", "screenY"] as const satisfies ReadonlyArray<keyof WindowFacts>
const WINDOW_STATES = ["dark", "visible", "focused"] as const satisfies ReadonlyArray<keyof WindowFacts>

function isWindowFacts(value: unknown): value is WindowFacts {
  return isRecord(value) && WINDOW_MEASURES.every((key) => isFiniteNumber(value[key])) && WINDOW_STATES.every((key) => isBoolean(value[key]))
}

export async function readWindowFacts(page: CdpPage) {
  const facts = await page.evaluate((): WindowFacts => ({
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    screenX,
    screenY,
  }))
  if (!isWindowFacts(facts)) throw new Error(`Claxedo's renderer reported malformed window facts: ${JSON.stringify(facts)}`)
  return facts
}

export async function requireBenchmarkWindow(page: CdpPage) {
  const facts = await readWindowFacts(page)
  const sized = facts.width === VIEWPORT.width && facts.height === VIEWPORT.height && facts.scale === VIEWPORT.deviceScaleFactor
  if (!sized || !facts.dark) throw new Error(`Claxedo's window is not the benchmark window: ${JSON.stringify(facts)}`)
  return facts
}

export async function requireVisibleFocusedWindow(page: CdpPage) {
  const front = async () => {
    const facts = await readWindowFacts(page)
    return facts.visible && facts.focused
  }
  if (await front()) return
  await page.command("Page.bringToFront")
  const deadline = performance.now() + 3_000
  while (performance.now() < deadline) {
    if (await front()) return
    await Bun.sleep(50)
  }
  throw new Error(`Claxedo's window is not visible and focused: ${JSON.stringify(await readWindowFacts(page))}`)
}
