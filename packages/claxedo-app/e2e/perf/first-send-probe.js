window.__firstSend = {}
window.__firstSendWatch = (text) => {
  window.__firstSend = {}
  const has = (selector, needle) => [...document.querySelectorAll(selector)].some((node) => node.textContent?.includes(needle) && node.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
  addEventListener("pointerdown", (event) => { window.__firstSend.down = event.timeStamp }, { capture: true, once: true })
  window.__claxedoPaintedFrames({
    sample: () => ({ message: has('[data-component="user-message"]', text), token: has('[data-component="text-part"]', "") }),
    painted: (seen, at) => {
      const marks = window.__firstSend
      if (marks.down === undefined) return
      if (marks.message === undefined && seen.message) marks.message = at - marks.down
      if (marks.token === undefined && seen.token) marks.token = at - marks.down
      return marks.message !== undefined && marks.token !== undefined
    },
  })
}
