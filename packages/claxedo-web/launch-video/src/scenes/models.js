import { h, harnessMark, HARNESSES, paint, pose } from "../lib/dom.js"
import { grid } from "../lib/grid.js"
import { clamp, ease, mix, span } from "../lib/time.js"
import { headline, subline } from "../lib/type.js"
import { shell, settingsRail } from "../ui/app.js"

const ACCOUNTS = {
  claude: ["Anthropic API key", "Added by you"],
  codex: ["ChatGPT plan", "Signed in with ChatGPT"],
  cursor: ["Cursor API key", "Added by you"],
  pi: ["OpenRouter API key", "Added by you"],
  opencode: ["OpenAI API key", "Added by you"],
}

/** Settings → Models: one block per harness, each on the person's own account. */
export const modelsScene = ({ L, at, cues, duration = 5 }) => {
  const el = h("div", { class: "layer" })
  const G = grid(L)
  const title = headline("Your accounts.\nYour models.", { size: G.headline, top: G.top, left: G.left, width: 640, align: "left" })
  const sub = subline("Your own subscriptions\nor API keys.\nNo credits to buy.", { size: G.subline, top: G.top + 230, left: G.left, width: 560, align: "left" })
  el.append(title.el, sub.el)

  const states = []
  const blocks = HARNESSES.map((harness) => {
    const [name, detail] = ACCOUNTS[harness.id]
    const state = h("span", { class: "state" }, h("i"), "Ready")
    states.push(state)
    return h(
      "section",
      { class: "harness-block" },
      h("header", {}, harnessMark(harness.id), harness.label),
      h("div", { class: "tabs" }, h("span", { class: "on" }, "Accounts"), h("span", {}, "Models"), h("span", { class: "link" }, "Add an account")),
      h("div", { class: "card-list" }, h("div", { class: "account-row" }, h("span", { class: "grow" }, h("b", { style: { fontWeight: "400" } }, name), h("small", {}, detail)), state)),
    )
  })
  const column = h(
    "div",
    { class: "settings-col" },
    h("h3", {}, "Models"),
    h("p", { class: "desc" }, "The accounts your agents run on, and which models each one offers."),
    blocks,
  )
  const content = h("div", { class: "settings" }, column)
  const win = shell({ width: 1260, height: 900, rail: settingsRail(), main: content })
  paint(win.el, { left: "760px", top: `${G.top + 10}px`, transformOrigin: "0 50%" })
  el.append(win.el)

  states.forEach((_, i) => cues.push({ t: at + 1.25 + i * 0.22, kind: "tick", soft: true }))

  const render = (time) => {
    const u = time - at
    title.render(time, at + 0.15, at + duration - 0.55)
    sub.render(time, at + 0.55, at + duration - 0.5)
    const enter = ease.out(span(u, 0, 1.1))
    const exit = ease.in(span(u, duration - 0.6, 0.6))
    pose(win.el, { o: clamp(enter * 1.6) * (1 - exit), x: (1 - enter) * 260 - exit * 120, s: mix(1, 1.025, ease.inOut(span(u, 0.6, duration))) })
    states.forEach((state, i) => {
      const p = ease.spring(span(u, 1.25 + i * 0.22, 0.5))
      pose(state, { o: clamp(p * 2), s: mix(0.8, 1, p), x: (1 - p) * 8 })
    })
  }
  return { el, start: at, end: at + duration, render }
}
