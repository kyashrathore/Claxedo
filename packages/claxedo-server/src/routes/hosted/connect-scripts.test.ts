import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { CONNECT_SCRIPT_SHA256_HEADER, MINIMUM_CONNECT_CLI_VERSION } from "@claxedo/account-contract/machine"
import { connectInstallersModule } from "../../../scripts/connect-installers"
import { ConnectScriptRoutes, connectCommands, invitationCommands, posixConnectScript, powershellConnectScript } from "./connect-scripts"

const ORIGIN = "https://app.claxedo.test"

describe("connect scripts", () => {
  test("the Worker's copy of the installers is the CLI's own install.sh and install.ps1", () => {
    const generated = readFileSync(path.join(import.meta.dirname, "../../workspace/connect-installers.generated.ts"), "utf8")
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
    expect(script).toContain(`param([string]$Code = "", [string]$ControlPlane = '${ORIGIN}', [string]$MinimumCliVersion = '${MINIMUM_CONNECT_CLI_VERSION}', [string]$Invitation = "", [string]$Root = "")`)
    expect(script.split("\n").filter((line) => line.trim() && !line.startsWith("#"))[0]).toMatch(/^param\(/)
  })

  test("the commands fetch the scripts from this plane and pass the code", async () => {
    expect(connectCommands(ORIGIN, "K7QM4PXD9R2TWB6HJ3NF")).toEqual({
      posix: `curl -fsSL ${ORIGIN}/api/claxedo/connect | sh -s -- K7QM4PXD9R2TWB6HJ3NF`,
      windows: `& ([scriptblock]::Create((irm ${ORIGIN}/api/claxedo/connect.ps1))) K7QM4PXD9R2TWB6HJ3NF`,
    })
    expect(connectCommands(ORIGIN), "with no code they only install").toEqual({
      posix: `curl -fsSL ${ORIGIN}/api/claxedo/connect | sh`,
      windows: `& ([scriptblock]::Create((irm ${ORIGIN}/api/claxedo/connect.ps1)))`,
    })
    const routes = ConnectScriptRoutes(ORIGIN)
    const posix = await routes.request("/connect")
    expect(posix.headers.get("content-type")).toContain("text/x-shellscript")
    expect(await posix.text()).toBe(posixConnectScript(ORIGIN))
    expect(await (await routes.request("/connect.ps1")).text()).toBe(powershellConnectScript(ORIGIN))
  })

  test("an invitation's commands pass the token and the folder exactly as written, and cloud-init runs the same shell command", () => {
    const folder = "/srv/it's: #app"
    const commands = invitationCommands(ORIGIN, "chx_inv_2.aHR0cHM.invitation_1.c2VjcmV0", folder)
    const [fetch, run] = commands.posix.split(" | ")
    expect(fetch).toBe(`curl -fsSL ${ORIGIN}/api/claxedo/connect`)
    const args = run.replace(/^sh -s -- /, "")
    const read = spawnSync("sh", ["-c", `set -- ${args}; printf '%s\\n' "$@"`], { encoding: "utf8" })
    expect(read.stdout.split("\n").slice(0, -1)).toEqual(["--invitation", "chx_inv_2.aHR0cHM.invitation_1.c2VjcmV0", "--root", folder])
    expect(commands.windows).toBe(`& ([scriptblock]::Create((irm ${ORIGIN}/api/claxedo/connect.ps1))) -Invitation chx_inv_2.aHR0cHM.invitation_1.c2VjcmV0 -Root '/srv/it''s: #app'`)
    const [header, key, item] = commands.cloudInit.split("\n")
    expect([header, key]).toEqual(["#cloud-config", "runcmd:"])
    expect(JSON.parse(item.replace(/^ {2}- /, ""))).toBe(commands.posix)
  })

  test("each script states the sha256 of exactly the text it serves", async () => {
    const routes = ConnectScriptRoutes(ORIGIN)
    for (const [route, script] of [["/connect", posixConnectScript(ORIGIN)], ["/connect.ps1", powershellConnectScript(ORIGIN)]] as const) {
      const response = await routes.request(route)
      const body = Buffer.from(await response.arrayBuffer())
      expect(response.headers.get(CONNECT_SCRIPT_SHA256_HEADER)).toBe(createHash("sha256").update(body).digest("hex"))
      expect(body.toString("utf8")).toBe(script)
    }
    const other = await ConnectScriptRoutes("https://staging.claxedo.test").request("/connect")
    expect(other.headers.get(CONNECT_SCRIPT_SHA256_HEADER)).not.toBe((await routes.request("/connect")).headers.get(CONNECT_SCRIPT_SHA256_HEADER))
  })
})
