/// <reference types="bun" />
import { expect, test } from "bun:test"
import { cloudWorkspaceName } from "./cloud-name"

test("a cloud workspace is shown by its name, and one with no name as Cloud workspace with its branch, never its id", () => {
  expect(cloudWorkspaceName("Cloud workspace", { id: "ws_1", name: "payments", branch: "main" })).toBe("payments")
  expect(cloudWorkspaceName("Cloud workspace", { id: "ws_2", name: "ws_2", branch: "dev" })).toBe("Cloud workspace · dev")
  expect(cloudWorkspaceName("Cloud workspace", { id: "ws_3", name: "" })).toBe("Cloud workspace")
})
