import "./login.css"
import { render } from "solid-js/web"
import { LoginDocument } from "./login-document"

const root = document.getElementById("root")
if (!root) throw new Error("The page has no #root element")
render(() => <LoginDocument />, root)
