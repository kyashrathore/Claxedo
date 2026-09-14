/**
 * The ExecStart a simulated manager runs in the CLI's own tests: `claxedo
 * connect` with two of its injectable dependencies replaced from the
 * environment the manager passes. `CLAXEDO_SIM_BEAT_MS` stands in for the beat
 * interval so a lifecycle runs in seconds, and no OpenCode SDK runtime is
 * started per served folder — the lifecycle observes readiness and the tunnel,
 * not sessions. The Tier R fixture runs `src/index.ts` itself instead.
 */
import { connect, defaultConnectDeps } from "../commands/connect"

const [command, ...args] = process.argv.slice(2)
if (command !== "connect") throw new Error(`the simulated unit runs \`connect\`, not ${JSON.stringify(command)}`)
const beatMs = Number(process.env.CLAXEDO_SIM_BEAT_MS)
if (!Number.isFinite(beatMs) || beatMs <= 0) throw new Error("CLAXEDO_SIM_BEAT_MS must be a positive number of milliseconds")

const deps = defaultConnectDeps()
deps.host.setInterval = (fn) => {
  const handle = setInterval(fn, beatMs)
  return { cancel: () => clearInterval(handle) }
}
deps.host.openCodeRuntime = () => undefined
process.exitCode = await connect(args, deps)
