import { h, loadImage, pose } from "./dom.js"
import { clamp, ease, rng } from "./time.js"

/**
 * A Daniell plate from the site, drawn the way TajPlate.astro reveals it: every dot
 * flickers as noise until its turn, then settles on the plate's own bit. The site
 * flickers with Math.random per animation frame; here the noise is a function of
 * the frame index so a re-rendered frame is identical. `keep(x, y)` thins the plate
 * to that fraction of its dots, so it reads as texture behind UI.
 */
export const plate = async (name, { dot = 2, seed = 11, keep } = {}) => {
  const image = await loadImage(`/site/src/assets/home/${name}.webp`)
  const width = image.naturalWidth
  const height = image.naturalHeight
  const read = h("canvas", { width, height }).getContext("2d", { willReadFrequently: true })
  read.drawImage(image, 0, 0)
  const alpha = read.getImageData(0, 0, width, height).data
  const count = width * height
  const bits = new Uint8Array(count)
  const random = rng(seed)
  for (let i = 0; i < count; i++) bits[i] = alpha[i * 4 + 3] > 0 && (!keep || random() < keep(i % width, Math.floor(i / width))) ? 1 : 0
  const order = new Float32Array(count).map(() => random())
  const noise = new Uint8Array(count * 2).map((_, i) => (random() < 0.34 * (keep ? keep((i % count) % width, Math.floor((i % count) / width)) : 1) ? 1 : 0))

  const canvas = h("canvas", { class: "plate", width, height, style: { width: `${width * dot}px`, height: `${height * dot}px` } })
  const draw = canvas.getContext("2d")
  const frame = draw.createImageData(width, height)
  for (let i = 0; i < count; i++) frame.data[i * 4] = frame.data[i * 4 + 1] = frame.data[i * 4 + 2] = 170
  let last = -1

  const render = (p, frameIndex) => {
    const settled = 1 - (1 - clamp(p)) ** 3
    if (settled >= 1 && last >= 1) return
    const shift = (frameIndex * 7919) % count
    for (let i = 0; i < count; i++) frame.data[i * 4 + 3] = (order[i] < settled ? bits[i] : noise[i + shift]) ? 255 : 0
    draw.putImageData(frame, 0, 0)
    last = settled
  }
  return { el: canvas, width: width * dot, height: height * dot, render }
}

const parseRects = (svg) =>
  [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="33"/g)].map(([, x, y]) => ({ x: (Number(x) - 44) / 432, y: (Number(y) - 44) / 432 }))

/** The pixel C from public/brand/claxedo-mark.svg, assembled square by square. */
export const pixelMark = async (size, { seed = 5 } = {}) => {
  const rects = parseRects(await (await fetch("/site/public/brand/claxedo-mark.svg")).text())
  const cell = (33 / 432) * size
  const random = rng(seed)
  const squares = rects.map((rect) => {
    const el = h("i", { style: { left: `${rect.x * size}px`, top: `${rect.y * size}px`, width: `${cell}px`, height: `${cell}px` } })
    const angle = random() * Math.PI * 2
    const reach = size * (0.35 + random() * 0.55)
    const sweep = rect.x * 0.55 + random() * 0.3
    return { el, dx: Math.cos(angle) * reach, dy: Math.sin(angle) * reach, delay: sweep }
  })
  const el = h("div", { class: "pixel-mark", style: { width: `${size}px`, height: `${size}px` } }, squares.map((square) => square.el))
  const render = (p) => {
    for (const square of squares) {
      const local = clamp((p - square.delay * 0.45) / 0.55)
      const travel = ease.out(local)
      pose(square.el, { o: clamp(local * 3), x: square.dx * (1 - travel), y: square.dy * (1 - travel), s: 0.25 + 0.75 * ease.spring(local) })
    }
  }
  return { el, render }
}

export const wordmark = async (height) => {
  const markup = await (await fetch("/site/public/brand/claxedo-wordmark-light.svg")).text()
  const el = h("div", { html: markup.replace(/^<\?xml[^>]*>\s*/, "") })
  const svg = el.firstElementChild
  const box = svg.viewBox.baseVal
  const ratio = box.width / box.height
  svg.setAttribute("width", `${height * ratio}`)
  svg.setAttribute("height", `${height}`)
  return { el, width: height * ratio }
}
