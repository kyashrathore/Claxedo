/**
 * Thin wrapper around the `agent-browser` CLI.
 * Every function shells out via Bun.spawn with `--session claxedo-e2e`.
 *
 * Uses the local binary directly (not npx) to avoid ~5s startup overhead per call.
 */
import { resolve } from "node:path"
import { mkdirSync } from "node:fs"
import sharp from "sharp"

const SESSION = "claxedo-e2e"
const BIN = resolve(import.meta.dir, "../../node_modules/.bin/agent-browser")

// --- Screenshot helpers ---
let screenshotDir = ""
let frameCounter = 0
let currentTest = ""

export function initScreenshots(
  dir = resolve(import.meta.dir, "screenshots"),
): void {
  screenshotDir = dir
  frameCounter = 0
  currentTest = ""
  mkdirSync(dir, { recursive: true })
}

export function setTestContext(name: string): void {
  currentTest = name
}

async function annotate(file: string, label: string, nn: string): Promise<void> {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const line1 = esc(`${nn}  ${label}`)
  const line2 = currentTest ? esc(currentTest) : ""

  const { width } = await sharp(file).metadata()
  const boxW = width || 1280
  const boxH = line2 ? 72 : 44
  const svg = `<svg width="${boxW}" height="${boxH}">
    <rect x="0" y="0" width="${boxW}" height="${boxH}" fill="rgba(0,0,0,0.78)" rx="0"/>
    <text x="16" y="28" font-size="22" fill="white" font-family="monospace, Menlo, Courier" font-weight="bold">${line1}</text>
    ${line2 ? `<text x="16" y="56" font-size="17" fill="#ccc" font-family="monospace, Menlo, Courier">${line2}</text>` : ""}
  </svg>`

  await sharp(file)
    .composite([{ input: Buffer.from(svg), gravity: "south" }])
    .toFile(file.replace(/\.png$/, ".tmp.png"))

  const { unlinkSync, renameSync } = await import("node:fs")
  unlinkSync(file)
  renameSync(file.replace(/\.png$/, ".tmp.png"), file)
}

export async function screenshot(label: string): Promise<string> {
  if (!screenshotDir) throw new Error("Call initScreenshots() first")
  frameCounter++
  const nn = String(frameCounter).padStart(2, "0")
  const file = resolve(screenshotDir, `${nn}-${label}.png`)
  await ab("screenshot", file)
  await annotate(file, label, nn)
  console.log(`[screenshot] ${nn}-${label}.png`)
  return file
}

export async function compileVideo(): Promise<string> {
  if (!screenshotDir) throw new Error("Call initScreenshots() first")
  const output = resolve(screenshotDir, "smoke-run.mp4")
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-framerate", "1/3",
      "-pattern_type", "glob",
      "-i", `${screenshotDir}/*.png`,
      "-vf", "scale=1280:-2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-y",
      output,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    console.warn(`[video] ffmpeg failed (exit ${code}): ${stderr.trim()}`)
    return ""
  }
  console.log(`[video] Compiled: ${output}`)
  return output
}

async function ab(...args: string[]): Promise<string> {
  const proc = Bun.spawn([BIN, "--session", SESSION, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(
      `agent-browser ${args.join(" ")} exited ${code}: ${stderr.trim() || text.trim()}`,
    )
  }
  return text.trim()
}

export async function open(url: string): Promise<string> {
  return ab("open", url)
}

export async function snapshot(): Promise<string> {
  return ab("snapshot")
}

export async function click(selector: string): Promise<string> {
  return ab("click", selector)
}

export async function fill(selector: string, text: string): Promise<string> {
  return ab("fill", selector, text)
}

export async function press(key: string): Promise<string> {
  return ab("press", key)
}

export async function waitFor(
  selector: string,
  timeout = 15_000,
  interval = 500,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const visible = await isVisible(selector)
    if (visible) return
    await Bun.sleep(interval)
  }
  throw new Error(`waitFor("${selector}") timed out after ${timeout}ms`)
}

export async function settle(ms = 1500): Promise<void> {
  await Bun.sleep(ms)
}

export async function isVisible(selector: string): Promise<boolean> {
  const out = await ab("is", "visible", selector)
  return out.toLowerCase().includes("true")
}

export async function getCount(selector: string): Promise<number> {
  const out = await ab("get", "count", selector)
  const n = parseInt(out, 10)
  return Number.isNaN(n) ? 0 : n
}

export async function getText(selector: string): Promise<string> {
  return ab("get", "text", selector)
}

export async function findLabelClick(label: string): Promise<string> {
  return ab("find", "label", label, "click")
}

export async function close(): Promise<string> {
  return ab("close")
}

// --- Snapshot analysis helpers ---

/** Count substring occurrences in an accessibility snapshot. */
export function countOccurrences(snap: string, needle: string): number {
  let count = 0
  let pos = 0
  while ((pos = snap.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

/** Count tab elements via Playwright locator (uses [data-tab-id] selector). */
export async function countTabs(): Promise<number> {
  return getCount("[data-tab-id]")
}
