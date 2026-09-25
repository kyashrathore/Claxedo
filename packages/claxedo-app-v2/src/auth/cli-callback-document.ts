import { submitCliCallback, takeCliCallback } from "./cli-callback"

const handoff = takeCliCallback()
if (handoff) submitCliCallback(document, handoff)
else document.body.textContent = "This CLI sign-in was already handed off or has expired. Start it again from the CLI."
