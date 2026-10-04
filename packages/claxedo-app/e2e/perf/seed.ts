import { SCRIPTED_ACP_HARNESS } from "../../../harness/e2e/harness/acp/connection"
import { acpScriptToken, type AcpScript } from "../../../harness/e2e/harness/acp/script"
import type { ClaxedoApi } from "../harness/api"
import { seedTurnScript } from "./stream-script"

export async function seedScriptedSession(input: {
  api: ClaxedoApi
  directory: string
  title: string
  turns: number
  writeScript: (name: string, script: AcpScript) => Promise<void>
}) {
  const session = await input.api.createSession(input.directory, { title: input.title, harness: SCRIPTED_ACP_HARNESS })
  for (let turn = 1; turn <= input.turns; turn += 1) {
    const script = `${input.title}-seed-${turn}`
    await input.writeScript(script, seedTurnScript(input.directory, turn))
    await input.api.prompt(input.directory, session.id, `Earlier question ${turn}. ${acpScriptToken(script)}`)
  }
  return session.id
}
