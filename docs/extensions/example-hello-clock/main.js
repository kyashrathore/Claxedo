// Example Claxedo user extension. Vanilla DOM on purpose: the extension API
// is framework-agnostic — mount() gets a container element and returns a
// dispose function. Copy this directory to ~/.claxedo/extensions/hello-clock/
// and run "Clock" from the command palette.

export function activate(api) {
  api.registerView({
    id: "clock",
    title: "Clock",
    mount(container, context) {
      const root = document.createElement("div")
      root.style.cssText = "padding:2rem;font-family:inherit;display:flex;flex-direction:column;gap:1rem;"

      const clock = document.createElement("div")
      clock.style.cssText = "font-size:2.5rem;font-variant-numeric:tabular-nums;"
      const tick = () => {
        clock.textContent = new Date().toLocaleTimeString()
      }
      tick()
      const timer = setInterval(tick, 1000)

      const where = document.createElement("div")
      where.style.opacity = "0.7"
      where.textContent = context.directory
        ? `Workspace: ${context.directory}`
        : `Loaded by ${api.extension.name}@${api.extension.version}`

      const counter = document.createElement("button")
      let count = 0
      counter.textContent = "Clicked 0 times"
      counter.addEventListener("click", () => {
        count += 1
        counter.textContent = `Clicked ${count} times`
      })

      root.append(clock, where, counter)
      container.append(root)

      // Dispose: runs when the tab unmounts. Clean up anything that outlives
      // the DOM — timers, sockets, subscriptions.
      return () => clearInterval(timer)
    },
  })
}
