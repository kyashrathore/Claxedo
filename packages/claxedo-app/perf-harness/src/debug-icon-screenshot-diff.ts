// TEMP tool: compare two directories written by debug-icon-surface-screenshots.
//
// Identical pixels produce identical PNG bytes here (same encoder, same
// dimensions), so the first test is a byte hash. When bytes differ the images
// are decoded in a headless page and compared pixel by pixel, because a
// one-pixel nudge and a whole-surface repaint are very different verdicts.
//
// Run:
//   bun src/debug-icon-screenshot-diff.ts /tmp/shots-base /tmp/shots-cand
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { chromium } from "@playwright/test"

const [baseDir, candDir] = process.argv.slice(2)
if (!baseDir || !candDir) {
  console.error("usage: bun src/debug-icon-screenshot-diff.ts <base-dir> <candidate-dir>")
  process.exit(2)
}

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16)

const browser = await chromium.launch({ headless: true, timeout: 30_000 })
const page = await browser.newPage()

const comparePixels = async (a: string, b: string) =>
  await page.evaluate(
    async ({ left, right }) => {
      const load = (data: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = reject
          image.src = data
        })
      const [one, two] = await Promise.all([load(left), load(right)])
      if (one.width !== two.width || one.height !== two.height) {
        return { sizeMismatch: `${one.width}x${one.height} vs ${two.width}x${two.height}` }
      }
      const draw = (image: HTMLImageElement) => {
        const canvas = document.createElement("canvas")
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext("2d", { willReadFrequently: true })!
        context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, image.width, image.height).data
      }
      const first = draw(one)
      const second = draw(two)
      let differing = 0
      let maxChannel = 0
      let minX = Infinity
      let minY = Infinity
      let maxX = -1
      let maxY = -1
      for (let index = 0; index < first.length; index += 4) {
        let delta = 0
        for (let channel = 0; channel < 4; channel++) {
          delta = Math.max(delta, Math.abs(first[index + channel]! - second[index + channel]!))
        }
        if (delta === 0) continue
        differing += 1
        maxChannel = Math.max(maxChannel, delta)
        const pixel = index / 4
        const x = pixel % one.width
        const y = Math.floor(pixel / one.width)
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
      return {
        differing,
        total: first.length / 4,
        maxChannel,
        box: maxX < 0 ? undefined : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      }
    },
    { left: a, right: b },
  )

let identical = 0
let changed = 0
let missing = 0

for (const scheme of ["light", "dark"]) {
  const left = join(baseDir, scheme)
  const right = join(candDir, scheme)
  if (!existsSync(left) || !existsSync(right)) {
    console.log(`[${scheme}] MISSING directory`)
    missing += 1
    continue
  }
  console.log(`\n=== ${scheme} ===`)
  for (const file of readdirSync(left).sort()) {
    const a = join(left, file)
    const b = join(right, file)
    if (!existsSync(b)) {
      console.log(`  ${file.padEnd(32)} MISSING in candidate`)
      missing += 1
      continue
    }
    if (hash(a) === hash(b)) {
      console.log(`  ${file.padEnd(32)} IDENTICAL (sha ${hash(a)})`)
      identical += 1
      continue
    }
    const result = await comparePixels(
      `data:image/png;base64,${readFileSync(a).toString("base64")}`,
      `data:image/png;base64,${readFileSync(b).toString("base64")}`,
    )
    if ("sizeMismatch" in result && result.sizeMismatch) {
      console.log(`  ${file.padEnd(32)} SIZE CHANGED ${result.sizeMismatch}`)
      changed += 1
      continue
    }
    const pixels = result as { differing: number; total: number; maxChannel: number; box?: { x: number; y: number; w: number; h: number } }
    if (pixels.differing === 0) {
      console.log(`  ${file.padEnd(32)} EQUAL PIXELS (bytes differ only)`)
      identical += 1
      continue
    }
    const box = pixels.box ? ` box=${pixels.box.w}x${pixels.box.h}@${pixels.box.x},${pixels.box.y}` : ""
    console.log(
      `  ${file.padEnd(32)} DIFF ${pixels.differing}/${pixels.total} px` +
        ` (${((pixels.differing * 100) / pixels.total).toFixed(3)}%) maxChannel=${pixels.maxChannel}${box}`,
    )
    changed += 1
  }
}

console.log(`\nidentical=${identical} changed=${changed} missing=${missing}`)
await browser.close()
process.exit(changed + missing > 0 ? 1 : 0)
