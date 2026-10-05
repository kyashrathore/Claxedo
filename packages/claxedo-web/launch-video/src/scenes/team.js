import { h, icon, paint, pose, text, toggle } from "../lib/dom.js"
import { grid } from "../lib/grid.js"
import { press } from "../lib/motion.js"
import { clamp, ease, keystrokes, mix, span, typed } from "../lib/time.js"
import { headline } from "../lib/type.js"
import { rail, shell } from "../ui/app.js"
import { SESSION_ROWS } from "../story.js"

const REPO = "your-org/agent-plugins"
const FOUND = [["Skills", 12], ["MCP servers", 4], ["Commands", 6], ["Hooks", 3]]
const PLUGINS = [
  { mark: "RE", name: "release-notes", kind: "Skill", text: "Drafts release notes from merged pull requests.", on: true },
  { mark: "LI", name: "linear", kind: "MCP server", text: "Reads and updates your team's issues.", on: true },
  { mark: "FR", name: "frontend-design", kind: "Skill", text: "Builds interfaces in your design system.", on: true },
  { mark: "PO", name: "posthog", kind: "MCP server", text: "Queries product analytics.", on: false },
]
const HARNESS_IDS = ["claude", "codex", "cursor", "opencode"]
const GITHUB = "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"

/** Marketplace: one repo added for the team, each teammate turns on what they need. */
export const teamScene = ({ L, at, cues, duration = 7.5 }) => {
  const G = grid(L)
  const el = h("div", { class: "layer" })
  const title = headline("Set up\nplugins once.", { size: G.headline, top: G.top, left: G.left, width: 600, align: "left" })
  const sub = headline("Add your team's plugin repo once.\nEveryone turns on\nwhat they need.", { size: G.subline, top: G.top + 230, left: G.left, width: 560, align: "left", tone: "subline" })
  const title2 = headline("Every agent,\nevery machine.", { size: G.headline, top: G.top, left: G.left, width: 640, align: "left" })
  const sub2 = headline("On in Claude Code, Codex,\nCursor and OpenCode, on every\nmachine you sign in to.", { size: G.subline, top: G.top + 230, left: G.left, width: 560, align: "left", tone: "subline" })
  el.append(title.el, sub.el, title2.el, sub2.el)

  const addSource = h("span", { class: "pill ghost" }, "+ Add source…")
  const repoPill = h("span", { class: "pill on" }, REPO)
  const allPill = h("span", { class: "pill on" }, "All")
  const cards = PLUGINS.map((plugin) => {
    const knob = h("i")
    const sw = h("span", { class: "switch" }, knob)
    const card = h(
      "div",
      { class: "plugin" },
      h("span", { class: "tile-mark" }, plugin.mark),
      h("span", { class: "grow" }, h("b", {}, plugin.name), h("span", { class: "kind" }, plugin.kind), h("p", {}, plugin.text), h("span", { class: "harnesses" }, HARNESS_IDS.map((id) => h("span", {}, id)))),
      sw,
    )
    return { card, sw, knob, plugin }
  })
  const group = h("div", {}, h("h6", {}, REPO, h("span", {}, `${PLUGINS.length} plugins`)), h("div", { class: "cards" }, cards.map((entry) => entry.card)))
  const market = h(
    "div",
    { class: "market" },
    h("div", { class: "search" }, icon("magnifying-glass"), "Search plugins, skills, MCP servers…"),
    h("div", { class: "pills" }, allPill, h("span", { class: "pill" }, "Claxedo ", h("em", {}, "2")), repoPill, addSource),
    group,
  )

  const field = h("span", { class: "grow" })
  const fieldCaret = h("i", { class: "ccaret", style: { display: "inline-block", width: "1.5px", height: "16px", marginBottom: "-3px", background: "var(--strong)" } })
  const fieldRow = h("p", { class: "field" }, h("span", { html: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="${GITHUB}"/></svg>`, style: { display: "grid" } }), h("span", { class: "grow" }, field, fieldCaret), h("em", { class: "badge" }, icon("lock"), "Private"))
  const found = FOUND.map(([kind, count]) => h("p", {}, h("span", {}, kind), h("b", {}, String(count))))
  const addButton = h("span", { class: "primary-btn" }, "Add to Marketplace")
  const dialog = h(
    "div",
    { class: "dialog", style: { width: "440px", left: "240px", top: "96px", transformOrigin: "50% 0" } },
    h("h4", {}, "Add source"),
    fieldRow,
    h("p", { style: { margin: "14px 0 6px", color: "var(--weak)", fontSize: "12.5px" } }, "In this repo"),
    h("div", { class: "found" }, found),
    h("div", { style: { marginTop: "14px" } }, addButton),
  )
  const main = h("div", { class: "pane" }, market, dialog)
  const sidebar = rail({ nav: "Marketplace", rows: SESSION_ROWS })
  const win = shell({ width: 1220, height: 880, rail: sidebar.el, main })
  paint(win.el, { left: `${L.W - 1220 + 60}px`, top: `${G.top + 10}px`, transformOrigin: "0 0" })
  el.append(win.el)

  const T = { pressAt: 1.1, openAt: 1.25, typeAt: 1.6, foundAt: 2.75, addAt: 3.6, closeAt: 3.72, cardsAt: 3.95, switches: [5.0, 5.3125, 5.625], swapAt: 4.7 }
  const strokes = keystrokes(REPO, at + T.typeAt, { rate: 0.042, seed: 41 })
  strokes.times.forEach((time) => cues.push({ t: time, kind: "key", soft: true }))
  cues.push({ t: at + T.pressAt, kind: "click" }, { t: at + T.addAt, kind: "select" })
  FOUND.forEach((_, i) => cues.push({ t: at + T.foundAt + i * 0.1, kind: "tick", soft: true }))
  T.switches.forEach((time, i) => cues.push({ t: at + time, kind: "pop", pitch: i + 1 }))

  const render = (time) => {
    const u = time - at
    title.render(time, at + 0.1, at + T.swapAt)
    sub.render(time, at + 0.5, at + T.swapAt)
    title2.render(time, at + T.swapAt + 0.3, at + duration - 0.45)
    sub2.render(time, at + T.swapAt + 0.7, at + duration - 0.4)

    const enter = ease.out(span(u, 0, 1.0))
    const exit = ease.in(span(u, duration - 0.55, 0.55))
    pose(win.el, { o: clamp(enter * 1.6) * (1 - exit), x: (1 - enter) * 220 - exit * 100, s: mix(1, 1.02, ease.inOut(span(u, 1, duration))) })

    paint(addSource, { transform: `scale(${press(u, T.pressAt, 0.92).toFixed(4)})` })
    toggle(addSource, "pressed", u >= T.pressAt && u < T.closeAt)
    const open = ease.rise(span(u, T.openAt, 0.4))
    const close = ease.in(span(u, T.closeAt, 0.22))
    pose(dialog, { o: clamp(open * 1.5) * (1 - close), s: mix(0.97, 1, open) * mix(1, 0.98, close), y: (1 - open) * 8 })
    text(field, typed(REPO, strokes, time))
    toggle(fieldRow, "focus", u < T.foundAt)
    paint(fieldCaret, { display: u >= T.openAt && u < T.foundAt ? "inline-block" : "none" })
    found.forEach((row, i) => {
      const p = ease.out(span(u, T.foundAt + i * 0.1, 0.3))
      pose(row, { o: clamp(p * 3), s: mix(0.94, 1, p) })
    })
    paint(addButton, { transform: `scale(${press(u, T.addAt, 0.95).toFixed(4)})` })

    const added = ease.out(span(u, T.cardsAt - 0.15, 0.3))
    paint(repoPill, { display: u >= T.cardsAt - 0.15 ? "" : "none", opacity: added.toFixed(3) })
    toggle(allPill, "on", u < T.cardsAt - 0.15)
    pose(group.firstElementChild, { o: added })
    cards.forEach(({ card, sw, knob, plugin }, i) => {
      const p = ease.out(span(u, T.cardsAt + i * 0.09, 0.55))
      pose(card, { o: clamp(p * 2.5), y: (1 - p) * 16 })
      const on = plugin.on ? ease.inOut(span(u, T.switches[i], 0.2)) : 0
      paint(sw, { background: `rgb(${mix(217, 26, on).toFixed(0)} ${mix(217, 28, on).toFixed(0)} ${mix(219, 31, on).toFixed(0)})` })
      paint(knob, { transform: `translateX(${(on * 14).toFixed(2)}px)` })
    })
  }
  return { el, start: at, end: at + duration, render }
}
