window.__firstSend = {}
window.__firstSendWatch = (text) => {
  window.__firstSend = {}
  const has = (selector, needle) => [...document.querySelectorAll(selector)].some((node) => node.textContent?.includes(needle) && node.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
  const tick = (at) => {
    const marks = window.__firstSend
    if (marks.down === undefined) {
      requestAnimationFrame(tick)
      return
    }
    if (marks.message === undefined && has('[data-component="user-message"]', text)) marks.message = at - marks.down
    if (marks.token === undefined && has('[data-component="text-part"]', "")) marks.token = at - marks.down
    if (marks.message === undefined || marks.token === undefined) requestAnimationFrame(tick)
  }
  addEventListener("pointerdown", (event) => { window.__firstSend.down = event.timeStamp }, { capture: true, once: true })
  requestAnimationFrame(tick)
}
