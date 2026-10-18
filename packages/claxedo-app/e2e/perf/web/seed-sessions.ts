import { acpScriptToken, type AcpScript } from "../../../../harness/e2e/harness/acp/script"
import type { ClaxedoApi } from "../../harness/api"
import { sessionRoute } from "../../harness/ui-names"
import { seedScriptedSession } from "../seed"
import { withValues } from "../stream-switch/surface"
import { seedCorpusSession } from "./corpus-seed"
import type { LongSession, StreamTarget } from "./target"

const MIB = 1024 * 1024
const MESSAGE_BYTES_PER_FIXTURE_BYTE = 1.8
const STREAM_SEED_TURNS = 3

export type SeedInput = {
  readonly api: ClaxedoApi
  readonly workspace: { readonly id: string; readonly directory: string; readonly projectId: string }
  readonly origin: string
  readonly writeScript: (name: string, script: AcpScript) => Promise<void>
  readonly log: (line: string) => void
}

export async function seedLongSessions(input: SeedInput, sizesMiB: readonly number[]): Promise<LongSession[]> {
  const sessions: LongSession[] = []
  for (const mib of sizesMiB) {
    const started = Date.now()
    const label = `${mib}m`
    const seeded = await seedCorpusSession({ api: input.api, directory: input.workspace.directory, writeScript: input.writeScript, title: `long-${label}`, targetBytes: (mib * MIB) / MESSAGE_BYTES_PER_FIXTURE_BYTE, endText: `End of the ${mib} MiB session.` })
    const messageBytes = JSON.stringify(await input.api.messages(input.workspace.directory, seeded.sessionId)).length
    input.log(`seeded the ${label} session: ${seeded.turns} turns, ${messageBytes} message bytes in ${Date.now() - started} ms`)
    sessions.push({ id: seeded.sessionId, url: `${input.origin}${sessionRoute(input.workspace.id, seeded.sessionId)}`, label, messageBytes })
  }
  return sessions
}

export async function seedStreamSessions(input: SeedInput, count: number): Promise<StreamTarget> {
  await withValues(input.workspace)
  const sessions = []
  for (let index = 0; index < count; index += 1) {
    const id = await seedScriptedSession({ api: input.api, directory: input.workspace.directory, writeScript: input.writeScript, title: `stream-${index}`, turns: STREAM_SEED_TURNS })
    sessions.push({ id, url: `${input.origin}${sessionRoute(input.workspace.id, id)}` })
  }
  return {
    directory: input.workspace.directory,
    sessions,
    prompt: async (sessionId, scriptName, script) => {
      await input.writeScript(scriptName, script)
      await input.api.promptAsync(input.workspace.directory, sessionId, `Write the long report. ${acpScriptToken(scriptName)}`)
    },
  }
}
