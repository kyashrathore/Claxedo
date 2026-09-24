import "#app-v2/styles"
import { MemoryRouter } from "@solidjs/router"
import { render } from "solid-js/web"
import { App } from "#app-v2"
import { desktopApi } from "../renderer/api"

async function renderWhenServerReady(root: HTMLElement) {
  const server = await desktopApi().awaitInitialization(() => undefined)
  render(() => <App router={MemoryRouter} serverUrl={server.url} />, root)
}

const root = document.getElementById("root")
if (!root) throw new Error("The desktop renderer document has no #root element")
void renderWhenServerReady(root)
