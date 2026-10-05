import { h, paint, pose, text, toggle } from "../lib/dom.js"
import { grid } from "../lib/grid.js"
import { blink, press } from "../lib/motion.js"
import { clamp, ease, keystrokes, span, streamed, typed } from "../lib/time.js"
import { headline } from "../lib/type.js"
import { PHONE_PROMPT, PHONE_REPLY, REPLY } from "../story.js"
import { phone } from "../ui/phone.js"

/**
 * film: the turn already finished while you were away; reply from the phone, then open the rail.
 * social: the whole loop on the phone — waking, streaming, "Ran 2 commands", then the reply.
 */
const TIMING = {
  film: { duration: 7.5, wake: null, p1: -10, ran: -10, p2: -10, typeAt: 1.7, rate: 0.048, sendAt: 3.05, replyAt: 3.45, sheetAt: 5.0 },
  social: { duration: 7.5, wake: [0.3, 2.1], p1: 2.25, ran: 3.35, p2: 3.6, typeAt: 4.95, rate: 0.038, sendAt: 6.0, replyAt: 6.3, sheetAt: null },
}

export const phoneScene = ({ L, at, cues, variant = "film" }) => {
  const T = TIMING[variant]
  const G = grid(L)
  const el = h("div", { class: "layer" })
  const title = headline("Keeps going\nwhile you're away.", { size: G.headline, top: G.top, left: G.left, width: 900, align: "left" })
  const sub = headline("Pick up every session on\ndesktop, browser or phone.", { size: G.subline, top: G.top + G.headline * 2.2 + 24, left: G.left, width: 760, align: "left", tone: "subline" })
  el.append(title.el, sub.el)

  const device = phone()
  const scale = L.portrait ? 1.28 : 1
  const left = L.portrait ? G.right - 430 * scale : 1250
  const top = L.portrait ? 604 : 90
  paint(device.el, { left: `${left}px`, top: `${top}px`, transformOrigin: "0 0" })
  el.append(device.el)

  const strokes = keystrokes(PHONE_PROMPT, at + T.typeAt, { rate: T.rate, seed: 31 })
  strokes.times.forEach((time) => cues.push({ t: time, kind: "key", soft: true }))
  cues.push({ t: at + T.sendAt, kind: "send" })
  if (T.sheetAt) cues.push({ t: at + T.sheetAt, kind: "click" })
  if (T.wake) cues.push({ t: at + T.wake[1], kind: "rise" }, { t: at + T.ran, kind: "tick" })

  const c = device.composer
  const render = (time) => {
    const u = time - at
    title.render(time, at + 0.1, at + T.duration - 0.5)
    sub.render(time, at + 0.7, at + T.duration - 0.45)

    const enter = ease.out(span(u, 0, 1.0))
    const exit = ease.in(span(u, T.duration - 0.5, 0.5))
    pose(device.el, { o: clamp(enter * 2) * (1 - exit), y: (1 - enter) * 260 + exit * 120, s: scale })

    const finished = !T.wake
    text(device.para1, finished ? REPLY[0] : streamed(REPLY[0], at + T.p1, time, 13).text)
    pose(device.ran, { o: finished ? 1 : clamp((u - T.ran) / 0.12) })
    paint(device.body, { display: finished ? "" : "none" })
    text(device.para2, finished ? REPLY[1] : streamed(REPLY[1], at + T.p2, time, 13).text)
    paint(device.para2, { display: device.para2.textContent ? "" : "none" })
    paint(device.para1, { display: device.para1.textContent ? "" : "none" })

    if (T.wake) {
      const shown = u < T.wake[1] + 0.4
      const collapse = ease.inOut(span(u, T.wake[1], 0.4))
      c.setNotice("Waking checkout", "", "")
      paint(c.notice, { display: shown ? "flex" : "none", height: `${(40 * (1 - collapse)).toFixed(1)}px`, overflow: "hidden" })
      paint(c.el.querySelector(".dock-head"), { display: shown ? "" : "none" })
    } else {
      paint(c.el.querySelector(".dock-head"), { display: "none" })
    }

    const sent = u >= T.sendAt
    c.setTyped(sent ? "" : typed(PHONE_PROMPT, strokes, time), u >= T.typeAt - 0.3 && !sent)
    paint(c.send, { transform: `scale(${press(u, T.sendAt, 0.86).toFixed(4)})` })
    const rise = ease.out(span(u, T.sendAt, 0.35))
    paint(device.bubble2, { display: sent ? "" : "none" })
    pose(device.bubble2, { o: rise, y: (1 - rise) * 20 })
    text(device.reply, streamed(PHONE_REPLY, at + T.replyAt, time, 12).text)
    paint(device.reply, { display: device.reply.textContent ? "" : "none" })

    const sheet = T.sheetAt === null ? 0 : ease.out(span(u, T.sheetAt + 0.1, 0.55))
    paint(device.toggleBtn, { transform: `scale(${press(u, T.sheetAt ?? -9, 0.88).toFixed(4)})` })
    toggle(device.toggleBtn, "pressed", T.sheetAt !== null && u >= T.sheetAt)
    paint(device.sheet.el, { transform: `translateX(${(-(1 - sheet) * 105).toFixed(2)}%)`, visibility: sheet > 0 ? "visible" : "hidden" })
    paint(device.scrim, { opacity: sheet.toFixed(3), visibility: sheet > 0 ? "visible" : "hidden" })
    const liveRow = device.sheet.rows[1]
    toggle(liveRow.el, "selected", true)
    paint(liveRow.lead, { opacity: (0.45 + 0.55 * blink(u, 1.2)).toFixed(3) })
  }
  return { el, start: at, end: at + T.duration, render }
}
