import { ICONS } from "/site/src/icons/index.ts"
import { HARNESS_MARKS } from "/site/harness-marks.js"

export const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue
    if (key === "class") el.className = value
    else if (key === "style") Object.assign(el.style, value)
    else if (key === "html") el.innerHTML = value
    else el.setAttribute(key, value === true ? "" : value)
  }
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) el.append(child)
  return el
}

const svg = (markup, className) => {
  const wrap = document.createElement("span")
  wrap.innerHTML = markup
  const el = wrap.firstElementChild
  if (className) el.setAttribute("class", className)
  return el
}

export const icon = (name, className = "icon") =>
  svg(`<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`, className)

/** Labels as the picker shows them; models as the app lists them (UX-audit screens and harness fixtures). */
export const HARNESSES = [
  { id: "claude", label: "Claude Code", model: "Claude Sonnet 5.5" },
  { id: "codex", label: "Codex", model: "GPT-6.1 Sol" },
  { id: "cursor", label: "Cursor", model: "Composer 1" },
  { id: "pi", label: "Pi", model: "GPT-6 Sol" },
  { id: "opencode", label: "OpenCode", model: "Claude Opus 5.5" },
]

export const harnessMark = (id, className = "mark") =>
  svg(`<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">${HARNESS_MARKS[id]}</svg>`, className)

/** Sets only the style properties that changed since the last frame. */
export const paint = (el, styles) => {
  const last = (el.__painted ??= {})
  for (const [key, value] of Object.entries(styles)) {
    if (last[key] === value) continue
    last[key] = value
    if (key.startsWith("--")) el.style.setProperty(key, value)
    else el.style[key] = value
  }
}

export const text = (el, value) => {
  if (el.__text !== value) el.textContent = el.__text = value
}

export const toggle = (el, name, on) => {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on)
}

/** opacity / translate / scale / blur in one call, the film's standard entrance. */
export const pose = (el, { o = 1, x = 0, y = 0, s = 1, blur = 0, r = 0 } = {}) =>
  paint(el, {
    opacity: o.toFixed(4),
    transform: `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(4)})${r ? ` rotate(${r.toFixed(3)}deg)` : ""}`,
    filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none",
    visibility: o <= 0.001 ? "hidden" : "visible",
  })

export const loadImage = async (src) => {
  const image = new Image()
  image.src = src
  await image.decode()
  return image
}
