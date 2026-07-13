import { describe, expect, test } from "vitest"
import { hostedDeployCommands } from "./deploy-hosted"

describe("hosted deploy command selection", () => {
  test("targets the explicit staging Worker environment", () => {
    expect(hostedDeployCommands({ staging: true, dryRun: true, targets: ["central"] })[0]!.args).toEqual([
      "deploy",
      "--env",
      "staging",
      "--dry-run",
      "--outdir",
      "dist-worker",
    ])
  })

  test("targets the top-level production Worker when staging is false", () => {
    expect(hostedDeployCommands({ staging: false, dryRun: false, targets: ["central"] })[0]!.args).toEqual([
      "deploy",
      "--env",
      "",
    ])
  })
})
