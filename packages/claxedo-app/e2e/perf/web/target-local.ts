import path from "node:path"
import { ensureAppBuilt } from "../../harness/app"
import { prepareHarness } from "../../harness/global-setup"
import { sessionCookie, signedOrigin, startSignedStack } from "../../harness/signed-stack"
import { sessionRoute } from "../../harness/ui-names"
import { releasePort, reservePort } from "../../../../harness/e2e/harness/ports"
import { analyzeDist } from "./bytes"
import { PROFILES, type Profile } from "./profiles"
import { seedScriptedSession } from "../seed"
import type { Target } from "./target"

const DIST_DIR = path.resolve(import.meta.dirname, "../../../dist-e2e-web-perf")

export type LocalTargetInput = { readonly seedTurns: number; readonly railSessions: number; readonly log: (line: string) => void }

/**
 * The signed e2e stack with the app served the way Cloudflare Pages serves it
 * (pre-compressed, immutable hashed assets, revalidated shell) and the owner's
 * machine holding one project: two sessions of `seedTurns` scripted turns to
 * open and switch between, listed first, above `railSessions` one-turn
 * sessions that fill the rail.
 */
export async function localTarget(input: LocalTargetInput): Promise<Target> {
  const started = Date.now()
  await prepareHarness()
  const frontPort = await reservePort()
  const relayPort = await reservePort()
  const build = await ensureAppBuilt({ serverUrl: signedOrigin(frontPort), outDir: DIST_DIR, relayOrigins: [`http://127.0.0.1:${relayPort}`] })
  input.log(`app ${build.built ? `built in ${build.ms} ms` : "already current"} at ${build.distDir}`)
  const bytes = await analyzeDist(build.distDir)
  input.log(`${bytes.chunks.length} dist files compressed (br 11, gzip 6) in ${bytes.compressMs} ms`)
  let profile: Profile = PROFILES.none
  const signed = await startSignedStack({
    label: "web-perf", frontPort, relayPort, distDir: build.distDir,
    shaping: { apiDelayMs: () => profile.apiDelayMs, encoded: bytes.encoded },
  })
  try {
    const workspace = await signed.makeWorkspace("web-perf", "Web perf")
    const seed = (title: string, turns: number) => seedScriptedSession({ api: signed.owner.api, directory: workspace.directory, writeScript: (name, script) => signed.local.acp.write(name, script), title, turns })
    for (let index = input.railSessions; index >= 1; index -= 1) await seed(`Earlier work ${index}`, 1)
    const second = await seed("Second session", input.seedTurns)
    const first = await seed("First session", input.seedTurns)
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
        releasePort(frontPort)
        releasePort(relayPort)
      },
    }
  } catch (error) {
    await signed.close()
    releasePort(frontPort)
    releasePort(relayPort)
    throw error
  }
}
