import { expect, test } from "bun:test"
import { createHarnessComposer } from "@claxedo/harness/compose"
import type { HarnessServices } from "@claxedo/harness/contract"
import { harnessCompositionOptions } from "../composition"

test("custom Pi composition uses its command without discovering a built-in executable", () => {
  const options = harnessCompositionOptions({
    env: { PATH: "/no-pi-here", HOME: "/tmp/isolated-pi" },
    placement: { placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: false },
    harnessStateRoot: "/tmp/isolated-pi/state", opencodeRoot: "/tmp/isolated-pi/opencode",
    store: () => { throw new Error("No store needed") },
  })
  const composer = createHarnessComposer({} as HarnessServices, options)
  const transport = composer.connection({
    descriptor: { connectionId: "custom-pi", providerKey: "pi-rpc", enabled: true, configRevision: 1,
      config: { label: "Custom Pi", command: process.execPath } },
    expectedRevision: 1, directory: "/tmp", secrets: {},
  })
  expect(transport.kind).toBe("pi-rpc")
})
