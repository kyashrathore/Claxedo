import { h, icon } from "../lib/dom.js"
import { COMMANDS, PHONE_PROMPT, PROMPT, SESSION_ROWS, TERMINAL_ROW } from "../story.js"
import { dock, rail, toolRow, userMessage } from "./app.js"

/** The app's phone layout (< 768 px): header, one transcript column, the composer, the rail as a sheet. */
export const phone = () => {
  const toggleBtn = h("span", { class: "tool-btn" }, icon("layout-left-partial"))
  const top = h("div", { class: "phone-top" }, toggleBtn, h("span", { class: "title" }, "Webhook retries"), icon("plus"))

  const bubble = userMessage(PROMPT)
  const para1 = h("p", { class: "agent-msg" })
  const ran = toolRow("Ran 2 commands")
  const body = h("div", { class: "tool-body" }, COMMANDS.map((line) => h("p", { class: line.startsWith("✓") ? "ok" : "" }, line)))
  const para2 = h("p", { class: "agent-msg" })
  const bubble2 = userMessage(PHONE_PROMPT)
  const reply = h("p", { class: "agent-msg" })
  const transcript = h("div", { class: "transcript", style: { top: "auto", bottom: "14px" } }, bubble, para1, ran, body, para2, bubble2, reply)
  const bodyEl = h("div", { class: "phone-body" }, transcript)

  const composer = dock({ where: "checkout", whereIcon: "cloud", harness: "claude", width: 382 })
  composer.el.querySelector(".context-row").style.display = "none"
  composer.setTyped("", false)
  Object.assign(composer.el.style, { position: "relative", width: "auto" })
  const dockWrap = h("div", { class: "phone-dock" }, composer.el)

  const sidebar = rail({ rows: [TERMINAL_ROW, ...SESSION_ROWS] })
  sidebar.el.classList.add("phone-sheet")
  sidebar.el.querySelector(".titlebar")?.remove()
  const scrim = h("div", { class: "phone-scrim" })

  const app = h("div", { class: "phone-app app-theme" }, top, bodyEl, dockWrap)
  const screen = h("div", { class: "screen app-theme" }, app, scrim, sidebar.el)
  const el = h("div", { class: "device" }, h("div", { class: "island" }), screen)
  return { el, toggleBtn, transcript, bubble, para1, ran, body, para2, bubble2, reply, composer, sheet: sidebar, scrim }
}
