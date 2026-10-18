import path from "node:path"
import { ensureAppBuilt } from "../../harness/app"
import { prepareHarness } from "../../harness/global-setup"
import { sessionCookie, startSignedStack } from "../../harness/signed-stack"
import { sessionRoute } from "../../harness/ui-names"
import { releasePort, reservePort } from "../../../../harness/e2e/harness/ports"
import type { AcpScript } from "../../../../harness/e2e/harness/acp/script"
import { analyzeDist } from "./bytes"
import { PROFILES, type Profile } from "./profiles"
import { seedScriptedSession } from "../seed"
import { seedLongSessions, seedStreamSessions } from "./seed-sessions"
import type { Target } from "./target"

const DIST_DIR = path.resolve(import.meta.dirname, "../../../dist-e2e-web-perf")

const UNLIMITED = 1_000_000
const UNLIMITED_REQUESTS = { CLAXEDO_DEFAULT_REQUEST_RATE_LIMIT: String(UNLIMITED), CLAXEDO_CONTROL_PLANE_RATE_LIMIT: String(UNLIMITED), CLAXEDO_CONNECTION_RATE_LIMIT: String(UNLIMITED) }

export type LocalTargetInput = { readonly seedTurns: number; readonly railSessions: number; readonly longMiB: readonly number[]; readonly streamSessions: number; readonly log: (line: string) => void }

export async function localTarget(input: LocalTargetInput): Promise<Target> {
  const started = Date.now()
  await prepareHarness()
  const frontPort = await reservePort()
  const relayPort = await reservePort()
  const ports = [frontPort, relayPort]
  const build = await ensureAppBuilt({ outDir: DIST_DIR })
  input.log(`app ${build.built ? `built in ${build.ms} ms` : "already current"} at ${build.distDir}`)
  const bytes = await analyzeDist(build.distDir)
  input.log(`${bytes.chunks.length} dist files compressed (br 11, gzip 6) in ${bytes.compressMs} ms`)
  let profile: Profile = PROFILES.none
  const signed = await startSignedStack({
    label: "web-perf", frontPort, relayPort, distDir: build.distDir,
    shaping: { apiDelayMs: () => profile.apiDelayMs, encoded: bytes.encoded },
    workerEnv: UNLIMITED_REQUESTS,
    requestLimit: UNLIMITED,
  }).catch((error: unknown) => {
    for (const port of ports) releasePort(port)
    throw error
  })
  try {
    const workspace = await signed.makeWorkspace("web-perf", "Web perf")
    const seed = (title: string, turns: number) => seedScriptedSession({ api: signed.owner.api, directory: workspace.directory, writeScript: (name, script) => signed.local.acp.write(name, script), title, turns })
    for (let index = input.railSessions; index >= 1; index -= 1) await seed(`earlier-${index}`, 1)
    const seedInput = { api: signed.owner.api, workspace, origin: signed.url, writeScript: (name: string, script: AcpScript) => signed.local.acp.write(name, script), log: input.log }
    const long = await seedLongSessions(seedInput, input.longMiB)
    const stream = input.streamSessions > 0 ? await seedStreamSessions(seedInput, input.streamSessions) : undefined
    const second = await seed("perf-second", input.seedTurns)
    const first = await seed("perf-first", input.seedTurns)
    input.log(`stack up with ${input.railSessions + 2 + long.length + (stream?.sessions.length ?? 0)} sessions in ${Date.now() - started} ms`)
    return {
      kind: "local",
      url: signed.url,
      cookies: [sessionCookie(signed.url, signed.owner)],
      sessions: [first, second].map((id) => ({ id, url: `${signed.url}${sessionRoute(workspace.id, id)}` })),
      long,
      stream,
      distDir: build.distDir,
      bytes,
      description: `the signed e2e stack at ${signed.url}, ${build.distDir}`,
      useProfile: (next) => { profile = next },
      close: async () => {
        await signed.close()
        for (const port of ports) releasePort(port)
      },
    }
  } catch (error) {
    await signed.close()
    for (const port of ports) releasePort(port)
    throw error
  }
}
