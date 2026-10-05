import { plate } from "../lib/art.js"
import { h, icon, paint, pose, text } from "../lib/dom.js"
import { grid } from "../lib/grid.js"
import { blink } from "../lib/motion.js"
import { clamp, ease, keystrokes, mix, span, typed } from "../lib/time.js"
import { headline } from "../lib/type.js"

const COMMAND = "bun run deploy:user-cloudflare"
const STEPS = ["D1 databases created", "Migrations applied", "Worker deployed", "App published"]

/** The real self-host command, as the site's DeployTerminal crop shows it, over the Jama Masjid plate. */
export const deployScene = async ({ L, at, cues, duration = 5, compact = false }) => {
  const G = grid(L)
  const el = h("div", { class: "layer" })
  const title = headline("Five minutes to\nyour own deploy.", { size: G.headline, top: G.top, left: G.left, width: 900, align: "left" })
  const sub = headline("Open source. MIT licensed.\nOn your own Cloudflare.", { size: G.subline, top: G.top + G.headline * 2.2 + 24, left: G.left, width: 700, align: "left", tone: "subline" })
  el.append(title.el, sub.el)

  const panel = L.portrait ? { left: G.left, top: 640, width: L.W - 2 * G.left, height: 900 } : { left: 900, top: G.top + 10, width: L.W - 900 - 60, height: 860 }
  const jama = await plate("plate-jama", { dot: 2, seed: 23 })
  const panelEl = h("div", { class: "plate-panel", style: { left: `${panel.left}px`, top: `${panel.top}px`, width: `${panel.width}px`, height: `${panel.height}px` } }, jama.el)
  paint(jama.el, { left: `${(panel.width - jama.width) * 0.5}px`, top: `${(panel.height - jama.height) * 0.75}px`, position: "absolute" })
  const cmd = h("span", {})
  const caret = h("i", { class: "tcaret", style: { display: "inline-block", width: ".6em", height: "1.1em", marginBottom: "-.2em", background: "var(--strong)" } })
  const steps = STEPS.map((step) => h("p", {}, h("span", { class: "ok" }, "✓"), ` ${step}`))
  const live = h("p", { class: "live" }, icon("check"), "Live at ", h("b", { style: { fontWeight: "500" } }, "https://claxedo.yourteam.dev"))
  const card = h(
    "div",
    { class: "term-card app-theme", style: { width: "640px", left: "50%", top: "50%", transformOrigin: "50% 50%" } },
    h("div", { class: "bar" }, h("span", { class: "lights" }, h("i"), h("i"), h("i")), "~/claxedo/packages/claxedo-server"),
    h("div", { class: "screen" }, h("p", {}, h("span", { class: "path" }, "claxedo-server "), cmd, caret), steps, h("p", {}, " "), live),
  )
  panelEl.append(card)
  el.append(panelEl)
  const cardScale = L.portrait ? 1.3 : 1.12

  const T = compact ? { typeAt: 0.2, steps: [1.2, 1.45, 1.7, 1.95], liveAt: 2.25 } : { typeAt: 0.6, steps: [1.875, 2.1875, 2.5, 2.8125], liveAt: 3.125 }
  const strokes = keystrokes(COMMAND, at + T.typeAt, { rate: compact ? 0.025 : 0.03, seed: 51 })
  strokes.times.forEach((time) => cues.push({ t: time, kind: "key", soft: true }))
  T.steps.forEach((time, i) => cues.push({ t: at + time, kind: "pop", pitch: i }))
  cues.push({ t: at + T.liveAt, kind: "chime" })

  const render = (time, frame) => {
    const u = time - at
    title.render(time, at + 0.1, at + duration - 0.45)
    sub.render(time, at + 0.5, at + duration - 0.4)
    jama.render(span(u, 0, 1.3), frame)
    const enter = ease.out(span(u, 0, 0.9))
    const exit = ease.in(span(u, duration - 0.5, 0.5))
    pose(panelEl, { o: clamp(enter * 1.8) * (1 - exit), y: (1 - enter) * 60 })
    const rise = ease.out(span(u, 0.2, 0.9))
    paint(card, { opacity: clamp(rise * 2).toFixed(3), transform: `translate(-50%, -50%) translateY(${((1 - rise) * 30).toFixed(2)}px) scale(${(cardScale * mix(0.98, 1, rise)).toFixed(4)})` })
    text(cmd, typed(COMMAND, strokes, time))
    paint(caret, { display: u < T.steps[0] - 0.1 ? "inline-block" : "none", opacity: (time <= strokes.end ? 1 : blink(u)).toFixed(3) })
    steps.forEach((step, i) => {
      const p = ease.out(span(u, T.steps[i], 0.22))
      pose(step, { o: p, x: (1 - p) * -6 })
    })
    const lp = ease.out(span(u, T.liveAt, 0.35))
    pose(live, { o: lp, y: (1 - lp) * 6 })
  }
  return { el, start: at, end: at + duration, render }
}
