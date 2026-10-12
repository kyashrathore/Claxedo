import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const COMPONENTS = ["control-plane", "relay", "sandbox-image"]

/**
 * Which staging components one deploy ships. The Cloudflare sandbox Worker's
 * image ships when the change policy says the baked packages changed (or it is
 * named). The control plane always deploys with the Boat image its own
 * checkout builds, published under its content-addressed tag: any organization
 * may add a Boat key, and the runtime in its new sandboxes is then never older
 * than the control plane that starts them.
 */
export function deployComponents({ requested = "all", sandboxChanged }) {
  if (requested !== "all" && !COMPONENTS.includes(requested)) throw new Error(`Unknown component ${requested}`)
  const selected = (name) => requested === "all" || requested === name
  const controlPlane = selected("control-plane")
  return {
    control_plane: controlPlane,
    relay: selected("relay"),
    sandbox_image: selected("sandbox-image") && (sandboxChanged || requested === "sandbox-image"),
    boat_image: controlPlane,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const components = deployComponents({
    requested: process.env.REQUESTED || "all",
    sandboxChanged: process.env.SANDBOX_CHANGED === "true",
  })
  const lines = Object.entries(components).map(([key, value]) => `${key}=${value}`)
  console.log(lines.join("\n"))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`)
}
