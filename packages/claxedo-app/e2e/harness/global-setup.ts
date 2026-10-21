import { ensureAppBuilt } from "./app"
import { PINNED_CLIS } from "./installed-cli"
import { ensureLaunchGateChild } from "./launch-gate-child"
import { DAEMON_PORT_ENV, fixedDaemonPort, releasePort, reservePort } from "../../../harness/e2e/harness/ports"

export async function prepareHarness() {
  const gate = await ensureLaunchGateChild()
  console.log(`[harness] launch gate child ${gate.built ? `built in ${gate.ms} ms` : "already built"}`)
  for (const [name, pinned] of Object.entries(PINNED_CLIS)) {
    const cli = await pinned.ensure().then((result) => `${result.version} ${result.installed ? "installed" : "already installed"}`, (error: unknown) => `not installed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
    console.log(`[harness] pinned ${name} ${cli}`)
  }
  const daemonPort = fixedDaemonPort() ?? (await reservePort())
  releasePort(daemonPort)
  process.env[DAEMON_PORT_ENV] = String(daemonPort)
  const result = await ensureAppBuilt()
  const how = result.built ? `built in ${result.ms} ms` : "already current"
  console.log(`[harness] app served from ${result.distDir} (${how})`)
}

export default prepareHarness
