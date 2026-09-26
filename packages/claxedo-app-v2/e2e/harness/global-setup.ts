import { ensureAppBuilt } from "./app"
import { ensureLaunchGateChild } from "./launch-gate-child"
import { ensurePinnedPi } from "./pinned-pi"
import { DAEMON_PORT_ENV, fixedDaemonPort, releasePort, reservePort } from "./ports"

export async function prepareHarness() {
  const gate = await ensureLaunchGateChild()
  console.log(`[harness] launch gate child ${gate.built ? `built in ${gate.ms} ms` : "already built"}`)
  const pi = await ensurePinnedPi()
  console.log(`[harness] Pi ${pi.version} ${pi.installed ? "installed" : "already installed"} for the stack`)
  const daemonPort = fixedDaemonPort() ?? (await reservePort())
  releasePort(daemonPort)
  process.env[DAEMON_PORT_ENV] = String(daemonPort)
  const serverUrl = `http://127.0.0.1:${daemonPort}`
  const result = await ensureAppBuilt({ serverUrl })
  const how = result.built ? `built in ${result.ms} ms` : "already current"
  console.log(`[harness] app served from ${result.distDir} for ${serverUrl} (${how})`)
}

export default prepareHarness
