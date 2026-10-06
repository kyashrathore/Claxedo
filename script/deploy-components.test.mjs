import assert from "node:assert/strict"
import test from "node:test"
import { deployComponents } from "./deploy-components.mjs"

await test("a Boat staging deploy always builds or reuses the image of its own checkout with the control plane", () => {
  assert.deepEqual(deployComponents({ requested: "all", sandboxChanged: false, driver: "boat" }), {
    control_plane: true, relay: true, sandbox_image: false, boat_image: true,
  })
  assert.equal(deployComponents({ requested: "all", sandboxChanged: true, driver: "boat" }).boat_image, true)
  assert.equal(deployComponents({ requested: "control-plane", sandboxChanged: false, driver: "boat" }).boat_image, true)
  assert.equal(deployComponents({ requested: "relay", sandboxChanged: true, driver: "boat" }).boat_image, false)
})

await test("the Cloudflare sandbox Worker's image ships when its packages changed or it is named, never for Boat", () => {
  assert.equal(deployComponents({ requested: "all", sandboxChanged: true, driver: "cloudflare" }).sandbox_image, true)
  assert.equal(deployComponents({ requested: "all", sandboxChanged: false, driver: "cloudflare" }).sandbox_image, false)
  assert.equal(deployComponents({ requested: "sandbox-image", sandboxChanged: false, driver: "cloudflare" }).sandbox_image, true)
  assert.equal(deployComponents({ requested: "control-plane", sandboxChanged: true, driver: "cloudflare" }).sandbox_image, false)
  assert.equal(deployComponents({ requested: "all", sandboxChanged: true, driver: "cloudflare" }).boat_image, false)
})

await test("an unknown driver or component refuses to plan a deploy", () => {
  assert.throws(() => deployComponents({ requested: "all", sandboxChanged: true, driver: "" }))
  assert.throws(() => deployComponents({ requested: "everything", sandboxChanged: true, driver: "boat" }))
})
