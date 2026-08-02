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

  test("installs Cloudflare Sandbox Worker dependencies from the committed lockfile", () => {
    const commands = hostedDeployCommands({
      staging: false,
      dryRun: false,
      targets: ["cloudflare-sandbox"],
    })

    expect(commands.find((command) => command.name === "cloudflare_sandbox.dependencies")).toMatchObject({
      cmd: "npm",
      args: ["ci"],
    })
  })
})
