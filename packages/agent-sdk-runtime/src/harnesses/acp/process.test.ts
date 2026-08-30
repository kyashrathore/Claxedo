import { expect, test } from "bun:test"
import { acpClientCapabilities } from "./process"

test("advertises only standard ACP client capabilities", () => {
  expect(acpClientCapabilities()).toEqual({
    auth: { terminal: false },
    fs: { readTextFile: true, writeTextFile: true },
    plan: {},
    terminal: true,
  })
})
