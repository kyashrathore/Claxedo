import { plate } from "../lib/art.js"
import { h, paint, pose } from "../lib/dom.js"
import { glide, press } from "../lib/motion.js"
import { grid } from "../lib/grid.js"
import { clamp, ease, keystrokes, mix, span, typed } from "../lib/time.js"
import { headline } from "../lib/type.js"
import { PROMPT } from "../story.js"
import { dock, wherePopover } from "../ui/app.js"
import { DOCK_AT } from "./session.js"


const TIMING = {
  film: { duration: 7.5, pressAt: 1.5, hot: [1.6, 2.15, 2.6, 3.05], selectAt: 3.45, noticeAt: 3.75, typeAt: 4.4, rate: 0.046, sendAt: 6.55 },
  social: { duration: 5.6, pressAt: 1.0, hot: [1.1, 1.5, 1.85, 2.2], selectAt: 2.5, noticeAt: 2.75, typeAt: 3.15, rate: 0.033, sendAt: 4.9 },
}

const LAYOUT = {
  landscape: { plate: { left: 420, top: -190, from: 200, to: 860 }, scale: 1.3, dockLeft: 144, dockBottom: 500 },
  portrait: { plate: { left: -330, top: 560, from: 960, to: 1640 }, scale: 1.3, dockLeft: 72, dockBottom: 820 },
}

/** "Where it runs": machines by name and cloud workspaces with their status, then an asleep workspace taking a message. */
export const whereScene = async ({ L, at, cues, variant = "film" }) => {
  const T = TIMING[variant]
  const P = LAYOUT[L.portrait ? "portrait" : "landscape"]
  const handoff = variant === "film"
  const el = h("div", { class: "layer" })
  const world = h("div", { class: "layer" })
  el.append(world)

  const thin = L.portrait ? (x, y) => clamp((P.plate.top + y * 2 - 1120) / 260, 0.3, 1) : (x) => clamp((P.plate.left + x * 2 - 980) / 320, 0.3, 1)
  const taj = await plate("daniell-taj-dither", { dot: 2, seed: 17, keep: thin })
  const fadeFrom = P.plate.from - P.plate.top
  const fadeTo = P.plate.to - P.plate.top
  const mask = `linear-gradient(to bottom, transparent ${fadeFrom}px, #000 ${fadeFrom + 110}px, #000 ${fadeTo - 140}px, transparent ${fadeTo}px), linear-gradient(to right, transparent 0, #000 420px, #000 calc(100% - 120px), transparent 100%)`
  paint(taj.el, { left: `${P.plate.left}px`, top: `${P.plate.top}px`, maskImage: mask, webkitMaskImage: mask, maskComposite: "intersect", webkitMaskComposite: "source-in" })
  world.append(taj.el)

  const G = grid(L)
  const title = headline(L.portrait ? "Wherever it\nshould run." : "Wherever it should run.", { size: G.headline, top: G.top, left: G.left, width: L.W - 2 * G.left, align: "left" })
  world.append(title.el)

  const composer = dock({ where: "studio-mac", whereIcon: "monitor", harness: "claude" })
  composer.setTyped("", false)
  paint(composer.notice, { height: "0px", overflow: "hidden", borderBottomWidth: "0px" })
  composer.setNotice("This workspace is asleep. Your next message wakes it.", "", "Wake now")
  const picker = wherePopover()
  const pill = h("div", { style: { position: "absolute", left: "6px", right: "6px", borderRadius: "8px", background: "var(--selected)" } })
  picker.el.prepend(pill)
  picker.rows.forEach((row) => paint(row.el, { zIndex: "1" }))

  const holder = h("div", { class: "abs", style: { width: "720px", left: `${P.dockLeft}px`, top: `${P.dockBottom}px`, transformOrigin: "0 0" } })
  paint(composer.el, { position: "absolute", left: "0", bottom: "0" })
  paint(picker.el, { left: "8px", top: "4px" })
  holder.append(composer.el, picker.el)
  el.append(holder)

  const strokes = keystrokes(PROMPT, at + T.typeAt, { rate: T.rate, seed: 9 })
  strokes.times.forEach((time) => cues.push({ t: time, kind: "key" }))
  cues.push({ t: at + T.pressAt, kind: "click" })
  T.hot.slice(1).forEach((time) => cues.push({ t: at + time, kind: "tick" }))
  cues.push({ t: at + T.selectAt, kind: "click" })
  cues.push({ t: at + T.sendAt, kind: "send" })

  let rows
  const render = (time, frame) => {
    const u = time - at
    if (!rows) rows = picker.rows.map((row) => ({ top: row.el.offsetTop, height: row.el.offsetHeight }))
    taj.render(span(u, 0, 1.6), frame)
    title.render(time, at + 0.15, at + T.duration - 0.6)

    const exit = handoff ? ease.soft(span(u, T.sendAt + 0.1, 0.55)) : ease.in(span(u, T.duration - 0.55, 0.55))
    const push = ease.inOut(span(u, T.typeAt - 0.4, T.sendAt - T.typeAt + 0.4))
    paint(world, { transformOrigin: `${P.dockLeft}px ${P.dockBottom}px`, transform: `scale(${(mix(1, 1.035, push) * mix(1, 1.04, exit)).toFixed(4)})`, opacity: (1 - exit).toFixed(3) })

    const enter = ease.rise(span(u, 0.35, 1.0))
    const travel = ease.inOut(span(u, T.sendAt + 0.2, T.duration - T.sendAt - 0.2))
    if (handoff) {
      pose(holder, { o: clamp(enter * 1.5), x: travel * (DOCK_AT.left - P.dockLeft), y: (1 - enter) * 70 + travel * (DOCK_AT.bottom - P.dockBottom), s: mix(P.scale, 1, travel) })
    } else {
      pose(holder, { o: clamp(enter * 1.5) * (1 - exit), y: (1 - enter) * 70 + exit * 60, s: P.scale })
    }
    const notice = ease.out(span(u, T.noticeAt, 0.5))
    paint(composer.notice, { height: `${(notice * 40).toFixed(2)}px`, borderBottomWidth: notice > 0 ? "1px" : "0px", opacity: notice.toFixed(3) })

    const open = ease.rise(span(u, T.hot[0], 0.4))
    const close = ease.in(span(u, T.selectAt + 0.15, 0.22))
    paint(picker.el, { top: `${composer.el.offsetTop + (notice * 40) + 40}px` })
    pose(picker.el, { o: open * (1 - close), s: mix(0.97, 1, open) * mix(1, 0.98, close), y: (1 - open) * -6 })
    paint(composer.whereChip, { transform: `scale(${press(u, T.pressAt, 0.94).toFixed(4)})` })
    composer.whereChip.classList.toggle("pressed", u >= T.pressAt && u < T.selectAt + 0.2)
    const index = glide(u, T.hot.map((at, i) => ({ at, value: i })), 0.2)
    const lo = Math.floor(index)
    const hi = Math.min(lo + 1, rows.length - 1)
    const f = index - lo
    paint(pill, { top: `${mix(rows[lo].top, rows[hi].top, f)}px`, height: `${mix(rows[lo].height, rows[hi].height, f)}px` })
    const chosen = u >= T.selectAt ? 3 : 0
    picker.rows.forEach((row, i) => paint(row.check, { opacity: i === chosen ? "1" : "0" }))
    const picked = picker.rows[chosen].option
    composer.setWhere(picked.name, picked.icon)

    const value = u >= T.sendAt + 0.05 ? "" : typed(PROMPT, strokes, time)
    composer.setTyped(value, u >= T.typeAt - 0.3 && u < T.sendAt)
    paint(composer.send, { transform: `scale(${press(u, T.sendAt, 0.86).toFixed(4)})` })
  }
  return { el, start: at, end: at + T.duration, render }
}
