import path from "node:path"
import { ensureAppBuilt } from "../../harness/app"
import { prepareHarness } from "../../harness/global-setup"
import { sessionCookie, startSignedStack, type SignedStack } from "../../harness/signed-stack"
import { hostedFetch, inviteHostedPerson } from "../../../../harness/e2e/harness/hosted-auth"
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

async function joinedAsAdmin(signed: SignedStack, name: string) {
  const person = await signed.signUp(name)
  const orgs = await hostedFetch(signed.hosted, "/api/control/orgs", {}, signed.owner.person)
  const [org] = await orgs.json() as Array<{ org_id: string }>
  if (!org) throw new Error("the signed stack's owner belongs to no organization")
  const token = await inviteHostedPerson(signed.hosted, signed.owner.person, person.person, org.org_id, "admin")
  const accepted = await hostedFetch(signed.hosted, "/api/control/invitations/accept", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }, person.person)
  if (!accepted.ok) throw new Error(`${name} could not accept the invitation: ${accepted.status} ${await accepted.text()}`)
  return { cookies: [sessionCookie(signed.url, person)], repositoryUrl: signed.hosted.gitUrl }
}

export type LocalTargetInput = { readonly seedTurns: number; readonly railSessions: number; readonly longMiB: readonly number[]; readonly streamSessions: number; readonly dist: string | undefined; readonly log: (line: string) => void }

export async function localTarget(input: LocalTargetInput): Promise<Target> {
  const started = Date.now()
  await prepareHarness()
  const frontPort = await reservePort()
  const relayPort = await reservePort()
  const ports = [frontPort, relayPort]
  const build = input.dist ? { distDir: path.resolve(input.dist), built: false, ms: 0 } : await ensureAppBuilt({ outDir: DIST_DIR })
  input.log(input.dist ? `app served as built at ${build.distDir}` : `app ${build.built ? `built in ${build.ms} ms` : "already current"} at ${build.distDir}`)
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
      newcomer: (label) => joinedAsAdmin(signed, `Perf Newcomer ${label}`),
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
