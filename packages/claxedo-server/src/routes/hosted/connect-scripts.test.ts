import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { MINIMUM_CONNECT_CLI_VERSION } from "@claxedo/account-contract/machine"
import { connectInstallersModule } from "../../../scripts/connect-installers"
import { ConnectScriptRoutes, connectCommands, posixConnectScript, powershellConnectScript } from "./connect-scripts"

const ORIGIN = "https://app.claxedo.test"

describe("connect scripts", () => {
  test("the Worker's copy of the installers is the CLI's own install.sh and install.ps1", () => {
    const generated = readFileSync(path.join(import.meta.dirname, "connect-installers.generated.ts"), "utf8")
    expect(generated, "run bun run generate:connect-installers").toBe(connectInstallersModule())
  })

  test("the POSIX script is install.sh with this plane and its accepted CLI set, and it still parses", () => {
    const script = posixConnectScript(ORIGIN)
    const lines = script.split("\n")
    expect(lines.slice(0, 4)).toEqual([
      "#!/bin/sh",
      `CLAXEDO_CONTROL_PLANE_URL='${ORIGIN}'`,
      `CLAXEDO_CLI_MIN_VERSION='${MINIMUM_CONNECT_CLI_VERSION}'`,
      "export CLAXEDO_CONTROL_PLANE_URL CLAXEDO_CLI_MIN_VERSION",
    ])
    expect(spawnSync("sh", ["-n"], { input: script }).status).toBe(0)
    const header = posixConnectScript("https://x.test/it's $HOME").split("\n").slice(1, 4).join("\n")
    const read = spawnSync("sh", ["-c", `${header}\nprintf %s "$CLAXEDO_CONTROL_PLANE_URL"`], { encoding: "utf8" })
    expect(read.stdout, "the shell reads back exactly the origin").toBe("https://x.test/it's $HOME")
  })

  test("the PowerShell script keeps param first and fills in its defaults", () => {
    const script = powershellConnectScript(ORIGIN)
    expect(script).toContain(`param([string]$Code = "", [string]$ControlPlane = '${ORIGIN}', [string]$MinimumCliVersion = '${MINIMUM_CONNECT_CLI_VERSION}')`)
    expect(script.split("\n").filter((line) => line.trim() && !line.startsWith("#"))[0]).toMatch(/^param\(/)
  })

  test("the commands fetch the scripts from this plane and pass the code", async () => {
    expect(connectCommands(ORIGIN, "K7QM4PXD9R2TWB6HJ3NF")).toEqual({
      posix: `curl -fsSL ${ORIGIN}/api/claxedo/connect | sh -s -- K7QM4PXD9R2TWB6HJ3NF`,
      windows: `& ([scriptblock]::Create((irm ${ORIGIN}/api/claxedo/connect.ps1))) K7QM4PXD9R2TWB6HJ3NF`,
    })
    const routes = ConnectScriptRoutes(ORIGIN)
    const posix = await routes.request("/connect")
    expect(posix.headers.get("content-type")).toContain("text/x-shellscript")
    expect(await posix.text()).toBe(posixConnectScript(ORIGIN))
    expect(await (await routes.request("/connect.ps1")).text()).toBe(powershellConnectScript(ORIGIN))
  })
})
