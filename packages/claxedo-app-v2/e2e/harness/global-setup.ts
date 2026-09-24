import { appChoice, ensureAppBuilt } from "./app"
import { ensureLaunchGateChild } from "./launch-gate-child"
import { DAEMON_PORT_ENV, fixedDaemonPort, releasePort, reservePort } from "./ports"

export async function prepareHarness() {
  const gate = await ensureLaunchGateChild()
  console.log(`[harness] launch gate child ${gate.built ? `built in ${gate.ms} ms` : "already built"}`)
  const app = appChoice()
  const daemonPort = fixedDaemonPort() ?? (await reservePort())
  releasePort(daemonPort)
  process.env[DAEMON_PORT_ENV] = String(daemonPort)
  const serverUrl = `http://127.0.0.1:${daemonPort}`
  const result = await ensureAppBuilt(app, { serverUrl })
  const how = result.built ? `built in ${result.ms} ms` : "already current"
  console.log(`[harness] app=${app} served from ${result.distDir} for ${serverUrl} (${how})`)
}

export default prepareHarness
