import { Hono } from "hono"
import { MINIMUM_CONNECT_CLI_VERSION } from "@claxedo/account-contract/machine"
import { powershellQuote, shellQuote } from "@claxedo/helpers/shell"
import { POSIX_INSTALLER, POWERSHELL_INSTALLER } from "./connect-installers.generated"

export const CONNECT_SCRIPT_PATH = "/api/claxedo/connect"

const SCRIPT_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" }

/** `install.sh` with this plane and its accepted CLI version set below the shebang, so a code is redeemed where it was minted. */
export function posixConnectScript(origin: string) {
  const [shebang, ...rest] = POSIX_INSTALLER.split("\n")
  return [
    shebang,
    `CLAXEDO_CONTROL_PLANE_URL=${shellQuote(origin)}`,
    `CLAXEDO_CLI_MIN_VERSION=${shellQuote(MINIMUM_CONNECT_CLI_VERSION)}`,
    "export CLAXEDO_CONTROL_PLANE_URL CLAXEDO_CLI_MIN_VERSION",
    ...rest,
  ].join("\n")
}

/** `install.ps1` with the defaults of its parameters filled in; `param` must stay the script's first statement. */
export function powershellConnectScript(origin: string) {
  return POWERSHELL_INSTALLER
    .replace('[string]$ControlPlane = ""', `[string]$ControlPlane = ${powershellQuote(origin)}`)
    .replace('[string]$MinimumCliVersion = ""', `[string]$MinimumCliVersion = ${powershellQuote(MINIMUM_CONNECT_CLI_VERSION)}`)
}

/** With no code the script only installs, replacing a CLI below the accepted version. */
export function connectCommands(origin: string, code?: string) {
  return {
    posix: `curl -fsSL ${origin}${CONNECT_SCRIPT_PATH} | sh${code ? ` -s -- ${code}` : ""}`,
    windows: `& ([scriptblock]::Create((irm ${origin}${CONNECT_SCRIPT_PATH}.ps1)))${code ? ` ${code}` : ""}`,
  }
}

/** Mounted at `/api/claxedo`; the scripts carry no secret, so they are served to anyone. */
export function ConnectScriptRoutes(origin: string) {
  return new Hono()
    .get("/connect", (c) => c.text(posixConnectScript(origin), 200, { ...SCRIPT_HEADERS, "content-type": "text/x-shellscript; charset=utf-8" }))
    .get("/connect.ps1", (c) => c.text(powershellConnectScript(origin), 200, { ...SCRIPT_HEADERS, "content-type": "text/plain; charset=utf-8" }))
}
