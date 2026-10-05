import { h, icon, harnessMark, HARNESSES, text } from "../lib/dom.js"

export const ACCOUNT = { name: "Ada", initial: "A" }

export const shell = ({ width, height, rail, main, bar = [] }) => {
  const mainEl = h("div", { class: "main" }, main)
  const win = h(
    "div",
    { class: "window app-theme", style: { width: `${width}px`, height: `${height}px` } },
    h("div", { class: "titlebar" }, h("div", { class: "lights" }, h("i"), h("i"), h("i")), icon("layout-left-partial")),
    h("div", { class: "mainbar" }, bar),
    rail,
    mainEl,
  )
  return { el: win, main: mainEl }
}

export const barButtons = () => {
  const buttons = { plus: h("span", { class: "tool-btn" }, icon("plus")), terminal: h("span", { class: "tool-btn" }, icon("terminal")), panel: h("span", { class: "tool-btn" }, icon("layout-right-partial")) }
  return { buttons, els: [buttons.plus, buttons.terminal, buttons.panel] }
}

export const row2 = ({ title, place, placeIcon, when, lead }) => {
  const meta = h("small", {}, placeIcon ? icon(placeIcon) : null, `${place} · ${when}`)
  const leadEl = h("span", { class: "lead" }, lead === "terminal" ? icon("terminal") : lead === "dot" ? h("i", { class: "dot" }) : null)
  const el = h("div", { class: "row2" }, leadEl, h("b", {}, title), meta)
  return { el, meta, lead: leadEl }
}

export const rail = ({ nav = "", project = "payments", rows = [] }) => {
  const navItem = (name, label) => h("div", { class: `rail-item${nav === label ? " selected" : ""}` }, icon(name), label)
  const built = rows.map(row2)
  const list = h("div", { class: "session-list" }, built.map((row) => row.el))
  const el = h(
    "aside",
    { class: "rail" },
    h("div", { class: "rail-nav" }, navItem("checklist", "Tasks"), navItem("marketplace", "Marketplace")),
    h("div", { class: "rail-label" }, "Projects", icon("settings-gear")),
    h("div", { class: "project-row" }, icon("folder"), project),
    list,
    h(
      "div",
      { class: "rail-foot" },
      navItem("settings-gear", "Settings"),
      h("div", { class: "account" }, h("span", { class: "avatar" }, ACCOUNT.initial), ACCOUNT.name),
    ),
  )
  return { el, rows: built, list }
}

export const settingsRail = () => {
  const item = (label, selected) => h("div", { class: `rail-item${selected ? " selected" : ""}` }, label)
  return h(
    "aside",
    { class: "rail settings-nav" },
    h("div", { class: "rail-item", style: { margin: "10px 8px 2px", color: "var(--weak)" } }, icon("chevron-double-left"), "Back"),
    h("h5", {}, "Settings"),
    h("div", { class: "group" }, "Account"),
    ["Usage", "Organization", "Models", "Connections", "Machines"].map((label) => item(label, label === "Models")),
    h("div", { class: "group" }, "Workspace"),
    ["Projects", "Presets"].map((label) => item(label)),
    h("div", { class: "group" }, "App"),
    ["Appearance", "Keyboard shortcuts", "App plugins"].map((label) => item(label)),
  )
}

/** The composer with its context row (project, where it runs, branch) and an optional notice above it. */
export const dock = ({ project = "payments", where = "studio-mac", whereIcon = "monitor", branch = "dev", harness = "claude", width = 720 }) => {
  const noticeText = h("span", {})
  const noticeMuted = h("span", { class: "muted" })
  const noticeAction = h("span", { class: "action" })
  const notice = h("div", { class: "notice" }, h("i", { class: "dot" }), noticeText, noticeMuted, noticeAction)
  const whereLabel = h("span", {}, where)
  const whereIconSlot = h("span", { style: { display: "contents" } }, icon(whereIcon))
  const whereChip = h("span", { class: "chip" }, whereIconSlot, whereLabel)
  const typedEl = h("span", {})
  const placeholder = h("span", { class: "placeholder" }, "Ask anything, / for commands, @ for context...")
  const caret = h("i", { class: "ccaret" })
  const input = h("div", { class: "composer-input" }, typedEl, caret, placeholder)
  const markSlot = h("span", { style: { display: "contents" } }, harnessMark(harness))
  const modelLabel = h("span", {}, HARNESSES.find((entry) => entry.id === harness).model)
  const harnessBtn = h("span", { class: "harness-btn" }, markSlot, modelLabel, icon("chevron-down"))
  const send = h("span", { class: "send" }, icon("send"))
  const el = h(
    "div",
    { class: "dock app-theme", style: { width: `${width}px` } },
    h(
      "div",
      { class: "dock-head" },
      notice,
      h(
        "div",
        { class: "context-row" },
        h("span", { class: "chip" }, h("span", { class: "letter" }, project[0].toUpperCase()), project),
        whereChip,
        h("span", { class: "chip muted" }, icon("branch"), branch),
      ),
    ),
    h("div", { class: "composer" }, input, h("div", { class: "composer-controls" }, icon("plus"), h("span", { class: "grow" }), harnessBtn, send)),
  )
  let currentWhere = { label: where, icon: whereIcon }
  let currentHarness = harness
  return {
    el, notice, whereChip, harnessBtn, send, caret, placeholder,
    setNotice(main, muted = "", action = "") {
      text(noticeText, main)
      text(noticeMuted, muted)
      text(noticeAction, action)
    },
    setTyped(value, focused) {
      text(typedEl, value)
      placeholder.style.display = value ? "none" : ""
      caret.style.display = focused ? "" : "none"
      send.classList.toggle("ready", value.length > 0)
    },
    setWhere(label, iconName) {
      if (currentWhere.label === label && currentWhere.icon === iconName) return
      currentWhere = { label, icon: iconName }
      text(whereLabel, label)
      whereIconSlot.replaceChildren(icon(iconName))
    },
    setHarness(id) {
      if (currentHarness === id) return
      currentHarness = id
      markSlot.replaceChildren(harnessMark(id))
      text(modelLabel, HARNESSES.find((entry) => entry.id === id).model)
    },
  }
}

export const WHERE_OPTIONS = [
  { name: "studio-mac", detail: "Your machine · Online", icon: "monitor" },
  { name: "build-box", detail: "Your machine · Offline", icon: "server" },
  { name: "payments", detail: "Cloud workspace · Running", icon: "cloud" },
  { name: "checkout", detail: "Cloud workspace · Asleep", icon: "cloud" },
]

export const wherePopover = (options = WHERE_OPTIONS) => {
  const rows = options.map((option) => {
    const check = icon("check", "icon check")
    const el = h("div", { class: "option" }, icon(option.icon), h("span", { class: "grow" }, h("b", {}, option.name), h("small", {}, option.detail)), check)
    return { el, check, option }
  })
  const el = h(
    "div",
    { class: "popover app-theme", style: { width: "360px" } },
    h("div", { class: "search" }, icon("magnifying-glass"), "Search where it runs"),
    rows.map((row) => row.el),
    h("div", { class: "sep" }),
    h("div", { class: "option action" }, icon("plus"), "New cloud workspace…"),
    h("div", { class: "option action" }, icon("monitor"), "Connect a machine…"),
  )
  return { el, rows }
}

export const harnessPopover = () => {
  const value = h("span", { class: "value" }, HARNESSES[0].label)
  const model = h("span", { class: "value" }, HARNESSES[0].model)
  const rows = HARNESSES.map((harness) => {
    const check = icon("check", "icon check")
    const el = h("div", { class: "option" }, harnessMark(harness.id), h("span", { class: "grow" }, h("b", {}, harness.label)), check)
    return { el, check, harness }
  })
  const el = h(
    "div",
    { class: "popover app-theme", style: { width: "320px", transformOrigin: "50% 100%" } },
    h("div", { class: "section-row" }, icon("chevron-down"), "Harness", value),
    rows.map((row) => row.el),
    h("div", { class: "sep" }),
    h("div", { class: "section-row" }, icon("chevron-right"), "Model", model),
    h("div", { class: "section-row" }, icon("chevron-right"), "Effort", h("span", { class: "value" }, "High")),
  )
  return { el, rows, value, model }
}

export const userMessage = (body) => h("div", { class: "user-msg" }, h("p", {}, body), h("span", { class: "avatar" }, ACCOUNT.initial))

export const toolRow = (label, iconName = "chevron-right") => h("div", { class: "tool-row" }, icon(iconName), h("span", {}, label))
