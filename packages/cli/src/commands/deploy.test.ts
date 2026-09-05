import { expect, test } from "bun:test"
import { deploy } from "./deploy"

test("deploy rejects removed split-placement options before doing platform work", async () => {
  await expect(deploy(["--tools", "daytona"])).rejects.toThrow("Unknown deploy option")
  await expect(deploy(["--harness=pi"])).rejects.toThrow("Unknown deploy option")
})
