import { pixelMark, plate, wordmark } from "../lib/art.js"
import { h, paint, pose, text } from "../lib/dom.js"
import { grid } from "../lib/grid.js"
import { clamp, ease, mix, span } from "../lib/time.js"
import { headline } from "../lib/type.js"
import { PHONE_REPLY, PROMPT, REPLY, SESSION_ROWS } from "../story.js"
import { dock, rail, shell, toolRow, userMessage } from "../ui/app.js"
import { phone } from "../ui/phone.js"

const desktop = () => {
  const sidebar = rail({ rows: SESSION_ROWS })
  sidebar.rows[0].el.classList.add("selected")
  const transcript = h("div", { class: "transcript", style: { top: "36px" } }, userMessage(PROMPT), h("p", { class: "agent-msg" }, REPLY[0]), toolRow("Ran 2 commands"), h("p", { class: "agent-msg" }, REPLY[1]))
  const composer = dock({ where: "checkout", whereIcon: "cloud", harness: "claude" })
  composer.notice.style.display = "none"
  composer.setTyped("", false)
  Object.assign(composer.el.style, { position: "absolute", left: "210px", bottom: "22px" })
  return shell({ width: 1400, height: 830, rail: sidebar.el, main: h("div", { class: "pane" }, transcript, composer.el) }).el
}

/** The last frame is the poster: the name and the action on the left, the product in its final state on the right. */
export const posterScene = async ({ L, at, cues, duration = 7.5 }) => {
  const G = grid(L)
  const portrait = L.portrait
  const el = h("div", { class: "layer" })

  const plateTop = portrait ? 1180 : 340
  const taj = await plate("daniell-taj-dither", { dot: 2, seed: 29, keep: portrait ? (x, y) => clamp((plateTop + y * 2 - 1500) / 300, 0.15, 1) : (x) => clamp((x * 2 + 120 - 1000) / 500, 0.12, 1) })
  const fadeFrom = (portrait ? 1350 : 560) - plateTop
  const fadeTo = (portrait ? 1900 : 1080) - plateTop
  const mask = `linear-gradient(to bottom, transparent ${fadeFrom}px, #000 ${fadeFrom + 120}px, #000 ${fadeTo - 80}px, transparent ${fadeTo}px)`
  paint(taj.el, { left: `${portrait ? -420 : 120}px`, top: `${plateTop}px`, maskImage: mask, webkitMaskImage: mask })
  el.append(taj.el)

  const win = desktop()
  const winScale = portrait ? 0.62 : 0.6
  paint(win, { left: `${portrait ? 300 : 900}px`, top: `${portrait ? 1000 : 200}px`, transformOrigin: "0 0" })
  const device = phone()
  text(device.para1, REPLY[0])
  text(device.para2, REPLY[1])
  text(device.reply, PHONE_REPLY)
  paint(device.el.querySelector(".dock-head"), { display: "none" })
  paint(device.sheet.el, { visibility: "hidden" })
  paint(device.scrim, { visibility: "hidden" })
  const phoneScale = portrait ? 0.86 : 0.62
  paint(device.el, { left: `${portrait ? 540 : 1500}px`, top: `${portrait ? 960 : 420}px`, transformOrigin: "0 0" })
  el.append(win, device.el)

  const markSize = portrait ? 150 : 120
  const mark = await pixelMark(markSize)
  paint(mark.el, { left: `${G.left - markSize * 0.04}px`, top: `${G.top + 20}px` })
  const word = await wordmark(portrait ? 92 : 76)
  paint(word.el, { position: "absolute", left: `${G.left - (portrait ? 13 : 11)}px`, top: `${G.top + markSize + 56}px` })
  const tagTop = G.top + markSize + (portrait ? 190 : 160)
  const tagline = headline(portrait ? "Own your coding\nagent app." : "Own your coding agent app.", { size: portrait ? 72 : 52, top: tagTop, left: G.left, width: 900, align: "left" })
  const ctaTop = tagTop + (portrait ? 210 : 110)
  const cta = h("div", { class: "btn-primary", style: { position: "absolute", left: `${G.left}px`, top: `${ctaTop}px`, transformOrigin: "0 50%" } }, "Download for macOS")
  const quiet = h("div", { class: "quiet", style: { position: "absolute", left: `${G.left}px`, top: `${ctaTop + 100}px` } }, "Windows, Linux and Intel Macs")
  const url = h("div", { class: "quiet", style: { position: "absolute", left: `${G.left}px`, top: `${ctaTop + 146}px`, color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: portrait ? "30px" : "26px" } }, "claxedo.com")
  el.append(mark.el, word.el, tagline.el, cta, quiet, url)

  cues.push({ t: at + 1.875, kind: "select" })

  const render = (time, frame) => {
    const u = time - at
    taj.render(span(u, 0.2, 1.6), frame)
    paint(taj.el, { opacity: ease.soft(span(u, 0, 0.6)).toFixed(3) })
    mark.render(span(u, 0, 1.25))
    const wp = ease.rise(span(u, 0.85, 0.9))
    pose(word.el, { o: clamp(wp * 1.6), y: (1 - wp) * 26, blur: (1 - wp) * 10 })
    tagline.render(time, at + 1.25)
    const cp = span(u, 1.875, 0.4)
    pose(cta, { o: clamp(cp * 4), s: mix(0.9, 1, ease.spring(cp)) })
    const qp = ease.out(span(u, 2.3, 0.6))
    pose(quiet, { o: qp, y: (1 - qp) * 8 })
    pose(url, { o: ease.out(span(u, 2.5, 0.6)), y: (1 - ease.out(span(u, 2.5, 0.6))) * 8 })

    const wIn = ease.out(span(u, 0.35, 1.1))
    pose(win, { o: clamp(wIn * 1.8), x: (1 - wIn) * 120, s: winScale })
    const pIn = ease.out(span(u, 0.75, 1.1))
    pose(device.el, { o: clamp(pIn * 1.8), y: (1 - pIn) * 160, s: phoneScale })
  }
  return { el, start: at, end: at + duration, render }
}
