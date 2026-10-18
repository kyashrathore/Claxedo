import fs from "node:fs/promises"
import path from "node:path"
import { git } from "../../../../harness/e2e/harness/git"
import type { Workspace } from "../../../../harness/e2e/harness/workspaces"
import type { ClaxedoApi } from "../../harness/api"
import type { Stack } from "../../harness/stack"
import { acpScriptToken } from "../../../../harness/e2e/harness/acp/script"
import { seedScriptedSession } from "../seed"
import { seedTurnScript } from "../stream-script"
import { seedCorpusSession } from "./corpus-seed"

export type SessionTarget = { id: string; replyIds: string[]; bytes: number; turns: number }
export type Fixture = { workspace: Workspace; railSessions: number; long: Record<string, SessionTarget>; shorts: SessionTarget[] }
export type FixtureInput = { railSessions: number; shortSessions: number; longMiB: number[] }

const MIB = 1024 * 1024
const MESSAGE_BYTES_PER_FIXTURE_BYTE = 1.8
const SHORT_TURNS = 3

export const longEndText = (mib: number) => `End of the ${mib} MiB session.`

async function target(api: ClaxedoApi, directory: string, id: string): Promise<SessionTarget> {
  const messages = await api.messages(directory, id)
  const lastUser = messages.findLastIndex((message) => message.info.role === "user")
  const replyIds = messages.slice(lastUser + 1).filter((message) => message.info.role === "assistant").map((message) => message.info.id)
  return { id, replyIds, bytes: JSON.stringify(messages).length, turns: messages.filter((message) => message.info.role === "user").length }
}

async function withValues(workspace: Workspace) {
  await fs.mkdir(path.join(workspace.directory, "src"), { recursive: true })
  await fs.writeFile(path.join(workspace.directory, "src/values.ts"), "export const value0 = 0\n")
  await git(workspace.directory, "add", "--", "src/values.ts")
  await git(workspace.directory, "commit", "-q", "-m", "values", "--", "src/values.ts")
  return workspace
}

export async function seedFixture(stack: Stack, api: ClaxedoApi, input: FixtureInput): Promise<Fixture> {
  const workspace = await withValues(await stack.daemon.makeWorkspace("main-thread", "Main thread"))
  const writeScript = stack.acp.write
  const directory = workspace.directory
  const seedShort = (title: string, turns: number) => seedScriptedSession({ api, directory, writeScript, title, turns })
  for (let index = 0; index < input.railSessions; index += 1) await seedShort(`rail-${index}`, 1)
  console.log(`[main-thread] seeded ${input.railSessions} rail sessions`)
  const shorts: SessionTarget[] = []
  for (let index = 0; index < input.shortSessions; index += 1) shorts.push(await target(api, directory, await seedShort(`short-${index}`, SHORT_TURNS)))
  const long: Record<string, SessionTarget> = {}
  for (const mib of input.longMiB) {
    const started = Date.now()
    const seeded = await seedCorpusSession({ api, directory, writeScript, title: `long-${mib}mib`, targetBytes: (mib * MIB) / MESSAGE_BYTES_PER_FIXTURE_BYTE, endText: longEndText(mib) })
    long[`${mib}m`] = await target(api, directory, seeded.sessionId)
    console.log(`[main-thread] seeded ${mib} MiB session: ${seeded.turns} turns, ${long[`${mib}m`]!.bytes} message bytes in ${Date.now() - started} ms`)
  }
  return { workspace, railSessions: input.railSessions, long, shorts }
}

export async function bumpShort(stack: Stack, api: ClaxedoApi, fixture: Fixture, short: SessionTarget, run: number) {
  const script = `bump-${run}`
  await stack.acp.write(script, seedTurnScript(fixture.workspace.directory, 100 + run))
  await api.prompt(fixture.workspace.directory, short.id, `Back to this one. ${acpScriptToken(script)}`)
  return target(api, fixture.workspace.directory, short.id)
}
