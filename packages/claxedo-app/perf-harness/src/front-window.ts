import type { BenchmarkPage } from "./agent-cdp-page"
import { readBoolean } from "./page-value"

/**
 * Readiness requires the window to be visible and focused, and an app launched
 * from a background process does not take focus while the user types in
 * another app. The T3 and OpenCode drivers raise their apps the same way before
 * every activation.
 */
export async function ensureFrontWindow(page: BenchmarkPage, pid: number): Promise<void> {
  const front = async () => readBoolean(await page.evaluate(() => document.visibilityState === "visible" && document.hasFocus()))
  if (await front()) return
  const raise = Bun.spawn({
    cmd: ["osascript", "-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${String(pid)}) to true`],
    stdout: "ignore",
    stderr: "ignore",
  })
  await Promise.race([raise.exited, Bun.sleep(5_000)])
  const deadline = performance.now() + 3_000
  while (performance.now() < deadline) {
    if (await front()) return
    await Bun.sleep(100)
  }
  throw new Error("Claxedo window is not visible and focused; keep the app frontmost during the run")
}
