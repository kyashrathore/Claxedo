import { plate } from "../lib/art.js"
import { h, HARNESSES, paint, pose, text, toggle } from "../lib/dom.js"
import { blink, glide } from "../lib/motion.js"
import { clamp } from "../lib/time.js"
import { dock, harnessPopover } from "../ui/app.js"

const STEP = 1.2

/** Site hero loop: the composer's harness picker steps through all five harnesses; frame 360 equals frame 0. */
export const loopScene = async ({ L, duration = HARNESSES.length * STEP }) => {
  const el = h("div", { class: "layer" })
  const taj = await plate("daniell-taj-dither", { dot: 2, seed: 29, keep: (x) => clamp((x * 2 + 300 - 1100) / 400, 0.3, 1) })
  const mask = "linear-gradient(to bottom, transparent 180px, #000 320px, #000 760px, transparent 900px)"
  paint(taj.el, { left: "300px", top: "-60px", maskImage: mask, webkitMaskImage: mask })
  el.append(taj.el)
  taj.render(1, 0)

  const scale = 1.45
  const holder = h("div", { class: "abs", style: { width: "720px", height: "446px", left: `${(L.W - 720 * scale) / 2 - 120}px`, top: `${(L.H - 446 * scale) / 2}px`, transformOrigin: "0 0" } })
  const composer = dock({ harness: "claude" })
  composer.notice.style.display = "none"
  composer.setTyped("", true)
  paint(composer.el, { position: "absolute", left: "0", top: "315px" })
  const picker = harnessPopover()
  paint(picker.el, { left: "352px", top: "0" })
  const pill = h("div", { style: { position: "absolute", left: "6px", width: "308px", height: "36px", borderRadius: "8px", background: "var(--selected)" } })
  picker.el.prepend(pill)
  picker.rows.forEach((row) => paint(row.el, { position: "relative", zIndex: "1" }))
  toggle(composer.harnessBtn, "pressed", true)
  holder.append(composer.el, picker.el)
  pose(holder, { s: scale })
  el.append(holder)

  const stops = Array.from({ length: HARNESSES.length + 1 }, (_, k) => ({ at: k * STEP, value: k }))
  const render = (time) => {
    const t = ((time % duration) + duration) % duration
    const position = glide(t, stops, 0.24)
    const row = position % HARNESSES.length
    const top = position > HARNESSES.length - 1 ? 40 + (HARNESSES.length - 1) * 36 * (HARNESSES.length - position) : 40 + row * 36
    paint(pill, { top: `${top}px` })
    const selected = Math.floor(t / STEP) % HARNESSES.length
    picker.rows.forEach((entry, i) => paint(entry.check, { opacity: i === selected ? "1" : "0" }))
    text(picker.value, HARNESSES[selected].label)
    text(picker.model, HARNESSES[selected].model)
    composer.setHarness(HARNESSES[selected].id)
    paint(composer.caret, { opacity: blink(t, STEP).toFixed(3) })
  }
  return { el, start: 0, end: duration, render }
}
