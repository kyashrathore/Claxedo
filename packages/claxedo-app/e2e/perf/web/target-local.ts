import path from "node:path"
import { ensureAppBuilt } from "../../harness/app"
import { prepareHarness } from "../../harness/global-setup"
import { sessionCookie, signedOrigin, startSignedStack } from "../../harness/signed-stack"
import { sessionRoute } from "../../harness/ui-names"
import { releasePort, reservePort } from "../../../../harness/e2e/harness/ports"
import { analyzeDist } from "./bytes"
import { PROFILES, type Profile } from "./profiles"
import { startRelayProxy } from "./relay-proxy"
import { seedScriptedSession } from "../seed"
import type { Target } from "./target"

const DIST_DIR = path.resolve(import.meta.dirname, "../../../dist-e2e-web-perf")

/**
 * Production allows 600 requests a minute per client (the Worker's own fuse and
 * its shared rate-limit binding), 120 on control routes and 6 workspace
 * connections a minute per person and workspace; three repetitions boot the
 * app fifteen times a minute, which a person never does.
 */
const UNLIMITED = 1_000_000
const UNLIMITED_REQUESTS = { CLAXEDO_DEFAULT_REQUEST_RATE_LIMIT: String(UNLIMITED), CLAXEDO_CONTROL_PLANE_RATE_LIMIT: String(UNLIMITED), CLAXEDO_CONNECTION_RATE_LIMIT: String(UNLIMITED) }

export type LocalTargetInput = { readonly seedTurns: number; readonly railSessions: number; readonly log: (line: string) => void }

/**
 * The signed e2e stack with the app served the way Cloudflare Pages serves it
 * (pre-compressed, immutable hashed assets, revalidated shell) and the owner's
 * machine holding one project: two sessions of `seedTurns` scripted turns to
 * open and switch between, listed first, above `railSessions` one-turn
 * sessions that fill the rail. A title doubles as the scripted turns' script
 * name, which the agent reads up to the first space, so titles carry none.
 */
export async function localTarget(input: LocalTargetInput): Promise<Target> {
  const started = Date.now()
  await prepareHarness()
  const frontPort = await reservePort()
  const relayPort = await reservePort()
  const relayFrontPort = await reservePort()
  const ports = [frontPort, relayPort, relayFrontPort]
  const build = await ensureAppBuilt({ serverUrl: signedOrigin(frontPort), outDir: DIST_DIR, relayOrigins: [`http://127.0.0.1:${relayFrontPort}`] })
  input.log(`app ${build.built ? `built in ${build.ms} ms` : "already current"} at ${build.distDir}`)
  const bytes = await analyzeDist(build.distDir)
  input.log(`${bytes.chunks.length} dist files compressed (br 11, gzip 6) in ${bytes.compressMs} ms`)
  let profile: Profile = PROFILES.none
  const relay = await startRelayProxy({ port: relayFrontPort, relayPort, delayMs: () => profile.apiDelayMs })
  const signed = await startSignedStack({
    label: "web-perf", frontPort, relayPort, relayUrl: relay.url, distDir: build.distDir,
    shaping: { apiDelayMs: () => profile.apiDelayMs, encoded: bytes.encoded },
    workerEnv: UNLIMITED_REQUESTS,
    requestLimit: UNLIMITED,
  }).catch(async (error: unknown) => {
    await relay.close()
    for (const port of ports) releasePort(port)
    throw error
  })
  try {
    const workspace = await signed.makeWorkspace("web-perf", "Web perf")
    const seed = (title: string, turns: number) => seedScriptedSession({ api: signed.owner.api, directory: workspace.directory, writeScript: (name, script) => signed.local.acp.write(name, script), title, turns })
    for (let index = input.railSessions; index >= 1; index -= 1) await seed(`earlier-${index}`, 1)
    const second = await seed("perf-second", input.seedTurns)
    const first = await seed("perf-first", input.seedTurns)
    input.log(`stack up with ${input.railSessions + 2} sessions in ${Date.now() - started} ms`)
    return {
      kind: "local",
      url: signed.url,
      cookies: [sessionCookie(signed.url, signed.owner)],
      sessions: [first, second].map((id) => ({ id, url: `${signed.url}${sessionRoute(workspace.id, id)}` })),
      distDir: build.distDir,
      bytes,
      description: `the signed e2e stack at ${signed.url}, ${build.distDir}`,
      useProfile: (next) => { profile = next },
      close: async () => {
        await signed.close()
        await relay.close()
        for (const port of ports) releasePort(port)
      },
    }
  } catch (error) {
    await signed.close()
    await relay.close()
    for (const port of ports) releasePort(port)
    throw error
  }
}
