import assert from "node:assert/strict"
import test from "node:test"
import { deployComponents } from "./deploy-components.mjs"

await test("a control-plane deploy always builds or reuses the Boat image of its own checkout", () => {
  assert.deepEqual(deployComponents({ requested: "all" }), {
    control_plane: true, relay: true, sandbox_image: false, boat_image: true,
  })
  assert.equal(deployComponents({ requested: "control-plane" }).boat_image, true)
  assert.equal(deployComponents({ requested: "relay" }).boat_image, false)
})

await test("staging's Cloudflare sandbox Worker ships only when it is named", () => {
  assert.equal(deployComponents({ requested: "all" }).sandbox_image, false)
  assert.equal(deployComponents({ requested: "control-plane" }).sandbox_image, false)
  assert.equal(deployComponents({ requested: "sandbox-image" }).sandbox_image, true)
})

await test("an unknown component refuses to plan a deploy", () => {
  assert.throws(() => deployComponents({ requested: "everything" }))
})
