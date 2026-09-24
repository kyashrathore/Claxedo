import type { Page } from "@playwright/test"

export type Comparison = { changedRatio: number; side: Buffer }

type PairState = { width: number; height: number; left: ImageBitmap; right: ImageBitmap; a: ImageData; b: ImageData; diff?: ImageData }
type PairScope = { parityPair?: PairState }

async function decodePair(input: { left: string; right: string }) {
  const bitmap = async (data: string) => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
  const [left, right] = await Promise.all([bitmap(input.left), bitmap(input.right)])
  const width = Math.max(left.width, right.width)
  const height = Math.max(left.height, right.height)
  const pixels = (image: ImageBitmap) => {
    const context = new OffscreenCanvas(width, height).getContext("2d")
    if (!context) throw new Error("no 2d canvas")
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0)
    return context.getImageData(0, 0, width, height)
  }
  ;(globalThis as PairScope).parityPair = { width, height, left, right, a: pixels(left), b: pixels(right) }
}

function diffPair(threshold: number) {
  const pair = (globalThis as PairScope).parityPair
  if (!pair) throw new Error("decode the pair first")
  const { a, b } = pair
  const diff = new ImageData(pair.width, pair.height)
  let changed = 0
  for (let index = 0; index < a.data.length; index += 4) {
    const delta = Math.max(...[0, 1, 2].map((channel) => Math.abs(a.data[index + channel] - b.data[index + channel])))
    const faded = 255 - (255 - (a.data[index] + a.data[index + 1] + a.data[index + 2]) / 3) * 0.2
    const hit = delta > threshold
    if (hit) changed += 1
    diff.data.set(hit ? [230, 30, 60, 255] : [faded, faded, faded, 255], index)
  }
  pair.diff = diff
  return changed / (pair.width * pair.height)
}

async function composePair(caption: string) {
  const pair = (globalThis as PairScope).parityPair
  if (!pair?.diff) throw new Error("diff the pair first")
  const gap = 16
  const header = 30
  const canvas = new OffscreenCanvas(pair.width * 3 + gap * 2, pair.height + header)
  const context = canvas.getContext("2d")
  if (!context) throw new Error("no 2d canvas")
  context.fillStyle = "#1f1f1f"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "#ffffff"
  context.font = "16px -apple-system, sans-serif"
  ;["v1", "v2", caption].forEach((title, column) => context.fillText(title, column * (pair.width + gap) + 8, 20))
  context.drawImage(pair.left, 0, header)
  context.drawImage(pair.right, pair.width + gap, header)
  context.putImageData(pair.diff, (pair.width + gap) * 2, header)
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

const KEEP_NAMES_HELPER = "globalThis.__name = globalThis.__name ?? ((target) => target)"

export async function compareShots(page: Page, v1: Buffer, v2: Buffer): Promise<Comparison> {
  await page.evaluate(KEEP_NAMES_HELPER)
  await page.evaluate(decodePair, { left: v1.toString("base64"), right: v2.toString("base64") })
  const changedRatio = await page.evaluate(diffPair, 24)
  const side = await page.evaluate(composePair, `diff: ${(changedRatio * 100).toFixed(2)}% of pixels`)
  return { changedRatio, side: Buffer.from(side, "base64") }
}
