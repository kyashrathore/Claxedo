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
  const server = await api.awaitInitialization(() => undefined)
  render(() => <App router={MemoryRouter} serverUrl={server.url} />, root)
}

const root = document.getElementById("root")
if (!root) throw new Error("The desktop renderer document has no #root element")
void renderWhenServerReady(root)
