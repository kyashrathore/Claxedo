import { h, harnessMark, HARNESSES, paint, pose, text, toggle } from "../lib/dom.js"
import { grid } from "../lib/grid.js"
import { blink, glide, press } from "../lib/motion.js"
import { clamp, ease, keystrokes, mix, span, typed } from "../lib/time.js"
import { subline } from "../lib/type.js"
import { dock, harnessPopover } from "../ui/app.js"

const COPY = "Every coding agent."

const TIMING = {
  film: { typeAt: 0.25, rate: 0.07, tilesAt: 2.5, tileStep: 0.3125, sublineAt: 4.4, flyAt: 6.25, popAt: 6.3, hot: [8.125, 8.75, 9.375, 10.0], selectAt: 10.625, closeAt: 11.25, exitAt: 11.9, end: 12.5 },
  social: { typeAt: 0.2, rate: 0.065, tilesAt: 2.2, tileStep: 0.25, flyAt: 4.6, popAt: 4.65, hot: [5.9, 6.3, 6.7, 7.1], selectAt: 7.5, closeAt: 8.0, exitAt: 8.5, end: 9.0 },
}

/** Popover geometry in its own pixels: 6 padding, a 34 section row, then 36 per harness row, mark 18 at x 16. */
const POPOVER = { width: 320, height: 307, rowTop: 40, rowHeight: 36, markX: 16, markSize: 18 }
const DOCK = { width: 720, height: 131, harnessRight: 672 }

export const agentsScene = ({ L, at, cues, variant = "film" }) => {
  const T = TIMING[variant]
  const portrait = L.portrait
  const G = grid(L)
  const el = h("div", { class: "layer" })

  const fontSize = portrait ? 132 : 120
  const copy = portrait ? "Every\ncoding agent." : COPY
  const typedText = h("span", {})
  const caret = h("i", { style: { display: "inline-block", width: ".065em", height: ".78em", marginLeft: ".04em", marginBottom: "-.05em", background: "var(--ink)", borderRadius: "2px" } })
  const title = h("div", { class: "headline left", style: { left: `${G.left}px`, right: "auto", top: `${G.top}px`, whiteSpace: "pre" } }, typedText, caret)
  title.style.setProperty("--size", `${fontSize}px`)
  el.append(title)

  const sub = portrait ? null : subline("Built in, side by side.\nNo lock-in.", { size: 34, top: 700 - 34 * 1.35 * 2, left: G.left, width: 620, align: "left" })
  if (sub) el.append(sub.el)

  const tileSize = portrait ? 220 : 150
  const gap = portrait ? 44 : 40
  const centers = portrait
    ? [0, 1, 2, 3, 4].map((i) => ({ x: G.left + tileSize / 2 + (i % 3) * (tileSize + gap), y: 760 + Math.floor(i / 3) * (tileSize + 110) }))
    : [0, 1, 2, 3, 4].map((i) => ({ x: G.left + tileSize / 2 + i * (tileSize + gap), y: 830 }))
  const tiles = HARNESSES.map((harness, i) => {
    const tile = h("div", { class: "tile abs", style: { width: `${tileSize}px`, height: `${tileSize}px`, left: `${centers[i].x - tileSize / 2}px`, top: `${centers[i].y - tileSize / 2}px`, borderRadius: `${tileSize * 0.24}px` } })
    const label = h("div", { class: "tile-label abs", style: { width: `${tileSize + 40}px`, left: `${centers[i].x - tileSize / 2 - 20}px`, top: `${centers[i].y + tileSize / 2 + 24}px`, fontSize: portrait ? "32px" : "24px" } }, harness.label)
    const mark = harnessMark(harness.id, "abs")
    paint(mark, { width: `${tileSize / 2}px`, height: `${tileSize / 2}px`, left: `${centers[i].x - tileSize / 4}px`, top: `${centers[i].y - tileSize / 4}px`, color: "var(--ink)" })
    return { tile, label, mark }
  })
  tiles.forEach(({ tile, label }) => el.append(tile, label))

  const scale = 1.3
  const camW = DOCK.width * scale
  const camH = (POPOVER.height + 8 + DOCK.height) * scale
  const camLeft = portrait ? G.left : G.right - camW
  const camTop = (portrait ? 1340 : 700) - camH
  const cam = h("div", { class: "abs", style: { width: `${DOCK.width}px`, height: `${POPOVER.height + 8 + DOCK.height}px`, left: `${camLeft}px`, top: `${camTop}px`, transformOrigin: "0 0" } })
  const composer = dock({ harness: "codex" })
  composer.notice.style.display = "none"
  composer.setTyped("", false)
  paint(composer.el, { position: "absolute", left: "0", top: `${POPOVER.height + 8}px` })
  const picker = harnessPopover()
  const popLeft = DOCK.harnessRight - POPOVER.width
  paint(picker.el, { left: `${popLeft}px`, top: "0", transformOrigin: "85% 100%" })
  const pill = h("div", { style: { position: "absolute", left: "6px", width: `${POPOVER.width - 12}px`, height: `${POPOVER.rowHeight}px`, borderRadius: "8px", background: "var(--selected)" } })
  picker.el.prepend(pill)
  picker.rows.forEach((row) => paint(row.el, { position: "relative", zIndex: "1" }))
  cam.append(composer.el, picker.el)
  el.append(cam)
  tiles.forEach(({ mark }) => el.append(mark))

  const targets = HARNESSES.map((_, i) => ({
    x: camLeft + (popLeft + POPOVER.markX + POPOVER.markSize / 2) * scale,
    y: camTop + (POPOVER.rowTop + i * POPOVER.rowHeight + POPOVER.rowHeight / 2) * scale,
  }))
  const markScale = (POPOVER.markSize * scale) / (tileSize / 2)

  const strokes = keystrokes(copy, at + T.typeAt, { rate: T.rate, seed: 3 })
  strokes.times.forEach((time) => cues.push({ t: time, kind: "key" }))
  tiles.forEach((_, i) => cues.push({ t: at + T.tilesAt + i * T.tileStep, kind: "pop", pitch: i }))
  cues.push({ t: at + T.flyAt, kind: "whoosh" })
  T.hot.forEach((time) => cues.push({ t: at + time, kind: "tick" }))
  cues.push({ t: at + T.selectAt, kind: "select" })

  const hotStops = [{ at: 0, value: 1 }, ...T.hot.map((time, i) => ({ at: time, value: [2, 3, 4, 0][i] }))]

  const render = (time) => {
    const u = time - at
    const exit = ease.in(span(u, T.exitAt, 0.45))
    text(typedText, typed(copy, strokes, time))
    const typing = time >= strokes.times[0] && time <= strokes.end + 0.05
    paint(caret, { opacity: ((typing ? 1 : blink(u)) * (1 - ease.soft(span(u, T.tilesAt - 0.2, 0.3)))).toFixed(3) })
    pose(title, { o: 1 - exit, y: -exit * 50, blur: exit * 8 })

    tiles.forEach(({ tile, label, mark }, i) => {
      const snap = span(u, T.tilesAt + i * T.tileStep, 0.38)
      const settle = ease.out(snap)
      const leave = ease.soft(span(u, T.flyAt + i * 0.04, 0.45))
      const y = (1 - settle) * 18
      const s = mix(0.9, 1, settle)
      pose(tile, { o: clamp(snap * 5) * (1 - leave), y, s: s * mix(1, 0.8, leave) })
      pose(label, { o: clamp(snap * 3 - 0.4) * (1 - ease.soft(span(u, T.flyAt - 0.15, 0.3))), y: (1 - settle) * 10 })
      const flight = span(u, T.flyAt + i * 0.06, 0.95)
      const landed = flight >= 1
      const f = ease.inOut(flight)
      const end = { x: targets[i].x - centers[i].x, y: targets[i].y - centers[i].y }
      const bend = { x: end.x * 0.18, y: end.y * 0.9 + y }
      pose(mark, {
        o: landed ? 0 : clamp(snap * 5),
        x: 2 * (1 - f) * f * bend.x + f * f * end.x,
        y: (1 - f) * (1 - f) * y + 2 * (1 - f) * f * bend.y + f * f * end.y,
        s: mix(s, markScale, f),
      })
      paint(picker.rows[i].el.querySelector(".mark"), { opacity: landed ? "1" : "0" })
    })

    if (sub) sub.render(time, at + T.sublineAt, at + T.exitAt)

    const dockIn = ease.out(span(u, T.flyAt - 0.45, 0.9))
    pose(cam, { o: clamp(dockIn * 2) * (1 - exit), x: (1 - dockIn) * (portrait ? 0 : 120), y: (1 - dockIn) * (portrait ? 120 : 30) + exit * 40, s: scale })
    const open = ease.rise(span(u, T.popAt, 0.4))
    const close = ease.in(span(u, T.closeAt, 0.22))
    pose(picker.el, { o: clamp(open * 1.4) * (1 - close), s: mix(0.97, 1, open) * mix(1, 0.97, close), y: (1 - open) * 6 + close * 6 })
    toggle(composer.harnessBtn, "pressed", u >= T.popAt && u < T.closeAt + 0.1)
    paint(pill, { top: `${POPOVER.rowTop + glide(u, hotStops, 0.2) * POPOVER.rowHeight}px` })
    const selected = u >= T.selectAt ? 0 : 1
    picker.rows.forEach((row, i) => paint(row.check, { opacity: i === selected ? "1" : "0" }))
    text(picker.value, HARNESSES[selected].label)
    text(picker.model, HARNESSES[selected].model)
    composer.setHarness(HARNESSES[selected].id)
    paint(composer.harnessBtn, { transform: `scale(${press(u, T.selectAt, 0.95).toFixed(4)})` })
  }

  return { el, start: at, end: at + T.end, render }
}
