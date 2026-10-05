import { h, pose } from "./dom.js"
import { ease, span } from "./time.js"

/**
 * Kinetic headline: each word rises out of a blur on the site's rise curve and
 * leaves upward. `lines` breaks the copy with "\n".
 */
export const headline = (copy, { size = 88, top = 0, left, width, align = "center", tone = "headline" } = {}) => {
  const words = []
  const lines = copy.split("\n").map((line, index, all) =>
    h(
      "div",
      {},
      line.split(" ").map((word, i, list) => {
        const el = h("span", { class: "word" }, i < list.length - 1 || index < all.length - 1 ? `${word} ` : word)
        words.push(el)
        return el
      }),
    ),
  )
  const style = { top: `${top}px`, "--size": `${size}px` }
  if (left !== undefined) Object.assign(style, { left: `${left}px`, right: "auto" })
  if (width !== undefined) style.width = `${width}px`
  const el = h("div", { class: `${tone}${align === "left" ? " left" : ""}` }, lines)
  for (const [key, value] of Object.entries(style)) el.style.setProperty(key, value)

  const render = (t, inAt, outAt = Infinity, { stagger = 0.06, dur = 0.95, outDur = 0.45, rise = 0.38, blur = 12 } = {}) => {
    words.forEach((word, i) => {
      const pin = ease.rise(span(t, inAt + i * stagger, dur))
      const pout = ease.in(span(t, outAt + i * stagger * 0.5, outDur))
      pose(word, { o: pin * (1 - pout), y: (1 - pin) * size * rise - pout * size * 0.3, blur: (1 - pin) * blur + pout * blur * 0.6 })
    })
  }
  return { el, render }
}

export const subline = (copy, options = {}) => headline(copy, { size: 30, ...options, tone: "subline" })
