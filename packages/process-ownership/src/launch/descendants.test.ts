import { expect, test } from "bun:test"
import { captureDescendants, captureOwnedGroup } from "./descendants"

test.skipIf(process.platform === "win32")("the kernel's and init's trees are never captured as a launch's", async () => {
  for (const pid of [0, 1]) {
    expect(await captureDescendants(pid)).toEqual([])
    expect(await captureOwnedGroup(pid)).toEqual([])
  }
})
