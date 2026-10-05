import { h, paint, pose, text, toggle } from "../lib/dom.js"
import { grid } from "../lib/grid.js"
import { blink, camera, press } from "../lib/motion.js"
import { clamp, ease, keystrokes, mix, span, streamed, typed } from "../lib/time.js"
import { headline } from "../lib/type.js"
import { barButtons, dock, rail, shell, toolRow, userMessage } from "../ui/app.js"
import { COMMANDS, PROMPT, REPLY, SESSION_ROWS, TERMINAL_COMMAND, TERMINAL_PROMPT, TERMINAL_ROW } from "../story.js"

/** The desktop window in shot 4; `DOCK_AT` is where its composer sits, so shot 3 can hand its composer over. */
const WINDOW = { left: 376, top: 204, width: 1400, height: 830 }
export const DOCK_AT = { left: WINDOW.left + 260 + (WINDOW.width - 260 - 720) / 2, bottom: WINDOW.top + WINDOW.height - 22 }

export const sessionScene = ({ L, at, cues, duration = 10 }) => {
  const G = grid(L)
  const el = h("div", { class: "layer" })
  const title = headline("A live session in the cloud.", { size: 72, top: G.top - 8, left: G.left, width: 1400, align: "left" })
  const title2 = headline("Or open a real terminal right beside it.", { size: 72, top: G.top - 8, left: G.left, width: 1500, align: "left" })

  const sidebar = rail({ rows: [TERMINAL_ROW, ...SESSION_ROWS] })
  const [termEntry, liveEntry] = sidebar.rows
  toggle(liveEntry.el, "selected", true)
  const { buttons, els } = barButtons()

  const bubble = userMessage(PROMPT)
  const para1 = h("p", { class: "agent-msg" })
  const ran = toolRow("Ran 2 commands")
  const body = h("div", { class: "tool-body" }, COMMANDS.map((line) => h("p", { class: line.startsWith("✓") ? "ok" : "" }, line)))
  const bodyWrap = h("div", { style: { overflow: "hidden" } }, body)
  const para2 = h("p", { class: "agent-msg" })
  const transcript = h("div", { class: "transcript", style: { top: "36px" } }, bubble, para1, ran, bodyWrap, para2)
  const chat = h("div", { class: "pane" }, transcript)

  const composer = dock({ where: "checkout", whereIcon: "cloud", harness: "claude" })
  composer.setTyped("", false)
  paint(composer.el, { position: "absolute", left: `${(WINDOW.width - 260 - 720) / 2}px`, bottom: "22px" })
  chat.append(composer.el)

  const termLine = h("span", {})
  const termCaret = h("i", { class: "tcaret" })
  const output = h("p", {}, "dev")
  const nextPrompt = h("p", {}, h("span", { class: "path" }, TERMINAL_PROMPT), h("i", { class: "tcaret" }))
  const term = h("div", { class: "terminal" }, h("p", {}, h("span", { class: "path" }, TERMINAL_PROMPT), termLine, termCaret), output, nextPrompt)
  const termPane = h("div", { class: "pane" }, term)

  const win = shell({ width: WINDOW.width, height: WINDOW.height, rail: sidebar.el, main: [chat, termPane], bar: els })
  paint(win.el, { left: `${WINDOW.left}px`, top: `${WINDOW.top}px` })
  el.append(win.el, title.el, title2.el)

  const T = { wakeEnd: 4.0, p1: 4.2, ran: 5.55, expand: 5.8, p2: 6.0, termPress: 7.15, termAt: 7.3, typeAt: 7.45, devAt: 8.5 }
  const strokes = keystrokes(TERMINAL_COMMAND, at + T.typeAt, { rate: 0.032, seed: 21 })
  strokes.times.forEach((time) => cues.push({ t: time, kind: "key" }))
  cues.push({ t: at + T.ran, kind: "tick" }, { t: at + T.expand, kind: "tick", soft: true }, { t: at + T.termPress, kind: "click" }, { t: at + T.devAt, kind: "select" })
  cues.push({ t: at + T.wakeEnd, kind: "rise" })

  const keys = [
    { s: 1, x: 830, y: 700 },
    { at: 3.4, dur: 1.0, s: 1.42, x: 830, y: 700 },
    { at: 5.4, dur: 1.4, s: 1.32, x: 830, y: 40 },
    { at: 7.3, dur: 0.5, s: 1, x: 830, y: 0 },
    { at: 9.1, dur: 1.5, s: 1.7, x: 300, y: 0 },
  ]

  const render = (time) => {
    const u = time - at
    title.render(time, at + 0.1, at + 2.5)
    title2.render(time, at + T.termAt, at + duration - 0.4)

    const enter = ease.soft(span(u, -0.6, 0.6))
    const exit = ease.in(span(u, duration - 0.5, 0.5))
    const cam = camera(u, keys)
    const terminalMode = u >= T.termAt
    const zoom = cam.s * mix(1, 0.94, exit)
    paint(win.el, { transformOrigin: "0 0" })
    pose(win.el, { o: enter * (1 - exit), x: cam.x * (1 - zoom), y: cam.y * (1 - zoom) + exit * 30, s: zoom })

    paint(composer.el, { visibility: u >= 0 ? "visible" : "hidden" })
    const sent = clamp(u / 0.35)
    pose(bubble, { o: ease.soft(sent), y: (1 - ease.out(sent)) * 24 })
    pose(liveEntry.el, { o: clamp(u / 0.2) })
    paint(liveEntry.el, { maxHeight: `${(ease.out(clamp(u / 0.35)) * 54).toFixed(1)}px` })

    const waking = u < T.wakeEnd + 0.4
    const collapse = ease.inOut(span(u, T.wakeEnd, 0.4))
    composer.setNotice("Waking checkout", "  Starting the machine, about a minute", "")
    paint(composer.notice, { height: `${(40 * (1 - collapse)).toFixed(2)}px`, overflow: "hidden", borderBottomWidth: collapse < 1 ? "1px" : "0px", display: waking ? "flex" : "none" })
    const sweep = ((u % 1.6) / 1.6) * 160 - 30
    const shimmerEl = composer.notice.children[1]
    toggle(shimmerEl, "shimmer", true)
    paint(shimmerEl, { "--a": `${sweep - 20}%`, "--b": `${sweep}%`, "--c": `${sweep + 20}%` })

    const one = streamed(REPLY[0], at + T.p1, time, 13)
    text(para1, one.text)
    pose(ran, { o: clamp((u - T.ran) / 0.12), y: (1 - ease.out(span(u, T.ran, 0.3))) * 8 })
    const open = ease.inOut(span(u, T.expand, 0.4))
    paint(bodyWrap, { height: `${(open * (body.offsetHeight + 0)).toFixed(1)}px`, opacity: open.toFixed(3) })
    paint(ran.firstElementChild, { transform: `rotate(${(open * 90).toFixed(1)}deg)` })
    text(para2, streamed(REPLY[1], at + T.p2, time, 16).text)
    const running = u < T.p2 + 1.0
    paint(liveEntry.lead, { opacity: running ? (0.45 + 0.55 * blink(u, 1.2)).toFixed(3) : "0" })

    paint(buttons.terminal, { transform: `scale(${press(u, T.termPress, 0.9).toFixed(4)})` })
    toggle(buttons.terminal, "pressed", u >= T.termPress && u < T.termAt + 0.3)
    const grow = ease.out(span(u, T.termAt, 0.35))
    paint(termEntry.el, { maxHeight: `${(grow * 54).toFixed(1)}px`, opacity: grow.toFixed(3), overflow: "hidden" })
    toggle(termEntry.el, "selected", terminalMode)
    toggle(liveEntry.el, "selected", !terminalMode)
    const swap = ease.soft(span(u, T.termAt, 0.22))
    paint(chat, { opacity: (1 - swap).toFixed(3), visibility: swap >= 1 ? "hidden" : "visible" })
    paint(termPane, { opacity: swap.toFixed(3), visibility: swap <= 0 ? "hidden" : "visible" })
    text(termLine, typed(TERMINAL_COMMAND, strokes, time))
    const done = u >= T.devAt
    paint(termCaret, { display: done ? "none" : "inline-block", opacity: (time >= strokes.times[0] && time <= strokes.end ? 1 : blink(u)).toFixed(3) })
    paint(output, { visibility: done ? "visible" : "hidden" })
    paint(nextPrompt, { visibility: done ? "visible" : "hidden" })
    paint(nextPrompt.lastChild, { opacity: blink(u - T.devAt).toFixed(3) })
  }
  return { el, start: at - 0.6, end: at + duration, render }
}
