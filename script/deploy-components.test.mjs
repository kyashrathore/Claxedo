import assert from "node:assert/strict"
import test from "node:test"
import { deployComponents } from "./deploy-components.mjs"

await test("a control-plane deploy always builds or reuses the Boat image of its own checkout", () => {
  assert.deepEqual(deployComponents({ requested: "all", sandboxChanged: false }), {
    control_plane: true, relay: true, sandbox_image: false, boat_image: true,
  })
  assert.equal(deployComponents({ requested: "all", sandboxChanged: true }).boat_image, true)
  assert.equal(deployComponents({ requested: "control-plane", sandboxChanged: false }).boat_image, true)
  assert.equal(deployComponents({ requested: "relay", sandboxChanged: true }).boat_image, false)
})

await test("the Cloudflare sandbox Worker's image ships when its packages changed or it is named", () => {
  assert.equal(deployComponents({ requested: "all", sandboxChanged: true }).sandbox_image, true)
  assert.equal(deployComponents({ requested: "all", sandboxChanged: false }).sandbox_image, false)
  assert.equal(deployComponents({ requested: "sandbox-image", sandboxChanged: false }).sandbox_image, true)
  assert.equal(deployComponents({ requested: "control-plane", sandboxChanged: true }).sandbox_image, false)
})

await test("an unknown component refuses to plan a deploy", () => {
  assert.throws(() => deployComponents({ requested: "everything", sandboxChanged: true }))
})
