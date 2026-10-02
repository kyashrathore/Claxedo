import "#app/styles"
import { MemoryRouter } from "@solidjs/router"
import { render } from "solid-js/web"
import { App } from "#app"
import type { ElectronAPI } from "../preload/types"
import { desktopApi } from "./api"

const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"])

function openExternalAnchors(api: ElectronAPI) {
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null
    if (!(anchor instanceof HTMLAnchorElement)) return
    const url = new URL(anchor.href)
    if (url.origin === window.location.origin || !EXTERNAL_PROTOCOLS.has(url.protocol)) return
    event.preventDefault()
    api.openLink(anchor.href)
  })
}

async function renderWhenServerReady(root: HTMLElement) {
  const api = desktopApi()
  openExternalAnchors(api)
  const status = document.createElement("main")
  status.setAttribute("role", "status")
  status.style.cssText = "padding:48px;max-width:640px;margin:auto;font:16px/1.5 system-ui;overflow-wrap:anywhere"
  status.textContent = "Starting Claxedo…"
  root.replaceChildren(status)
  let server: Awaited<ReturnType<ElectronAPI["awaitInitialization"]>>
  try {
    server = await api.awaitInitialization(() => undefined)
  } catch (error) {
    status.setAttribute("role", "alert")
    const title = document.createElement("h1")
    title.textContent = "Claxedo could not start"
    const detail = document.createElement("p")
    detail.textContent = error instanceof Error ? error.message : String(error)
    const restart = document.createElement("button")
    restart.textContent = "Restart Claxedo"
    restart.onclick = () => api.relaunch()
    status.replaceChildren(title, detail, restart)
    return
  }
  root.replaceChildren()
  render(() => <App router={MemoryRouter} serverUrl={server.url} />, root)
}

const root = document.getElementById("root")
if (!root) throw new Error("The desktop renderer document has no #root element")
void renderWhenServerReady(root)
