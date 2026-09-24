import "./ui/styles.css"
import "./shell/styles/index.css"
import "./shell/styles/ui-overrides.css"
import "@opencode-ai/ui/v2/menu-v2.css"
import "@opencode-ai/ui/v2/select-v2.css"
import "@opencode-ai/ui/v2/tooltip-v2.css"
import "./transcript/styles.css"
import { render } from "solid-js/web"
import { App } from "./app"

const root = document.getElementById("root")
if (!root) throw new Error("The page has no #root element")
render(() => <App />, root)
