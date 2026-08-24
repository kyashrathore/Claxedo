import { expect, test } from "bun:test"
import { Show } from "solid-js"

function SolidBunPreloadFixture(props: { ready: boolean }) {
  return <Show when={props.ready}>ready</Show>
}

test("the Solid test preload owns TSX transformation before Bun parses it", () => {
  expect(String(SolidBunPreloadFixture)).not.toContain("jsxDEV")
})
