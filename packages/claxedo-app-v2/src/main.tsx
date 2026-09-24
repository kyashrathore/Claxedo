import "./ui/styles.css"
import { render } from "solid-js/web"
import { App } from "./app"

const root = document.getElementById("root")
if (!root) throw new Error("The page has no #root element")
render(() => <App />, root)
