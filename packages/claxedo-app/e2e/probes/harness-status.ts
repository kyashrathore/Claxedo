import {
  acpScriptToken,
  ApiError,
  ClaxedoApi,
  frameSessionId,
  frameType,
  installedCli,
  SCRIPTED_ACP_HARNESS,
  startStack,
  type EventStream,
  type SessionHarness,
  type Stack,
} from "../harness"
import { prepareHarness } from "../harness/global-setup"
import { beginObservation, recordTurn, renderReport, writeReport, type TurnRecord } from "./harness-status-report"

type Probe = { stack: Stack; api: ClaxedoApi; directory: string; stream: EventStream; records: TurnRecord[]; skipped: string[] }

const PI: SessionHarness = { id: "pi", access: "native" }
const CLAUDE: SessionHarness = { id: "claude", access: "native" }
const CODEX: SessionHarness = { id: "codex", access: "native" }

async function settle(probe: Probe, sessionId: string, label: string) {
  await probe.stream.waitFor(
    (frame) => frameSessionId(frame) === sessionId && (frameType(frame) === "session.idle" || frameType(frame) === "session.error"),
    { label: `${label}: session.idle or session.error`, timeoutMs: 60_000 },
  )
}

async function promptOutcome(probe: Probe, sessionId: string, text: string) {
  try {
    await probe.api.prompt(probe.directory, sessionId, text)
    return "turn completed"
  } catch (error) {
    if (error instanceof ApiError) return `prompt answered ${error.status}`
    throw error
  }
}

async function runTurn(probe: Probe, input: { harness: string; turn: string; session: SessionHarness; prompt: string; before?: () => Promise<void> }) {
  const session = await probe.api.createSession(probe.directory, { title: `${input.harness} ${input.turn}`, harness: input.session, permissionMode: permissionModeFor(input.session) })
  const observation = beginObservation(probe.stream, session.id)
  await input.before?.()
  const outcome = await promptOutcome(probe, session.id, input.prompt)
  await settle(probe, session.id, `${input.harness} ${input.turn}`).catch((error: Error) => probe.skipped.push(`${input.harness} ${input.turn}: ${error.message}`))
  probe.records.push(recordTurn(probe.stream, observation, { harness: input.harness, turn: input.turn, outcome }))
}

function permissionModeFor(session: SessionHarness) {
  if (session.id === "claude") return "bypassPermissions"
  if (session.id === "codex") return "full-access"
  return undefined
}

async function acpText(probe: Probe) {
  await probe.stack.acp.write("probe-text", { steps: [{ kind: "reasoning", text: "thinking" }, { kind: "text", text: "Probe text reply" }] })
  await runTurn(probe, { harness: "acp", turn: "text", session: SCRIPTED_ACP_HARNESS, prompt: `Say something. ${acpScriptToken("probe-text")}` })
}

async function acpError(probe: Probe) {
  await probe.stack.acp.write("probe-error", { steps: [{ kind: "text", text: "partial" }, { kind: "error", message: "Scripted ACP failure" }] })
  await runTurn(probe, { harness: "acp", turn: "error", session: SCRIPTED_ACP_HARNESS, prompt: `Fail please. ${acpScriptToken("probe-error")}` })
}

async function acpPermission(probe: Probe) {
  await probe.stack.acp.write("probe-permission", { steps: [{ kind: "permission", tool: "execute", title: "Run ls", input: { command: "ls" }, text: "README.md" }, { kind: "text", text: "Listed" }] })
  const session = await probe.api.createSession(probe.directory, { title: "acp permission", harness: SCRIPTED_ACP_HARNESS })
  const observation = beginObservation(probe.stream, session.id)
  const turn = probe.api.promptAsync(probe.directory, session.id, `Run ls. ${acpScriptToken("probe-permission")}`)
  const outcome = await answerPermission(probe, session.id)
  await turn
  await settle(probe, session.id, "acp permission")
  probe.records.push(recordTurn(probe.stream, observation, { harness: "acp", turn: "permission", outcome }))
}

async function answerPermission(probe: Probe, sessionId: string) {
  const asked = await probe.stream.waitFor((frame) => frameSessionId(frame) === sessionId && frameType(frame) === "permission.asked", { label: "permission.asked" }).then(() => true, () => false)
  const pending = (await probe.api.permissions(probe.directory)).filter((row) => row.sessionID === sessionId)
  if (!pending.length) return asked ? "permission.asked arrived but GET /permission listed nothing" : "no permission.asked and GET /permission listed nothing"
  await probe.api.replyPermission(probe.directory, sessionId, pending[0].id, "once")
  return asked ? "permission answered once through the API" : "GET /permission listed it without a permission.asked frame; answered once"
}

async function acpQuestion(probe: Probe) {
  await probe.stack.acp.write("probe-question", { steps: [{ kind: "question", message: "Which colour?", options: ["Blue", "Red"] }] })
  const session = await probe.api.createSession(probe.directory, { title: "acp question", harness: SCRIPTED_ACP_HARNESS })
  const observation = beginObservation(probe.stream, session.id)
  const turn = probe.api.promptAsync(probe.directory, session.id, `Ask me. ${acpScriptToken("probe-question")}`)
  const outcome = await answerQuestion(probe, session.id)
  await turn
  await settle(probe, session.id, "acp question")
  probe.records.push(recordTurn(probe.stream, observation, { harness: "acp", turn: "question", outcome }))
}

async function answerQuestion(probe: Probe, sessionId: string) {
  const asked = await probe.stream.waitFor((frame) => frameSessionId(frame) === sessionId && frameType(frame) === "question.asked", { label: "question.asked" }).then(() => true, () => false)
  const pending = (await probe.api.questions(probe.directory)).filter((row) => row.sessionID === sessionId)
  if (!pending.length) return asked ? "question.asked arrived but GET /question listed nothing" : "no question.asked and GET /question listed nothing"
  await probe.api.replyQuestion(probe.directory, pending[0].id, [[JSON.stringify({ answer: "Blue" })]])
  return asked ? "question answered through the API" : "GET /question listed it without a question.asked frame; answered"
}

async function cliTurns(probe: Probe, name: "claude" | "codex", session: SessionHarness) {
  const cli = await installedCli(name)
  if (!cli.available) {
    probe.skipped.push(`${name}: ${cli.reason}`)
    return
  }
  await modelTurns(probe, name, session)
}

async function modelTurns(probe: Probe, name: string, session: SessionHarness) {
  const marker = `PROBE-${name.toUpperCase()}`
  await runTurn(probe, { harness: name, turn: "text", session, prompt: `Reply with exactly this one token and nothing else: ${marker}` })
  const errorMarker = `${marker}-ERROR`
  const release = probe.stack.scripted.scriptError({ marker: errorMarker, status: 401, message: "scripted authentication failure" })
  await runTurn(probe, { harness: name, turn: "error (model answers 401)", session, prompt: `Reply with exactly this one token and nothing else: ${errorMarker}` })
  release()
}

async function main() {
  const startedAt = new Date()
  await prepareHarness()
  const stack = await startStack({ label: "probe-harness-status" })
  try {
    const workspace = await stack.daemon.makeWorkspace("probe")
    const probe: Probe = { stack, api: new ClaxedoApi(stack.url), directory: workspace.directory, stream: await stack.events(workspace.directory), records: [], skipped: [] }
    await acpText(probe)
    await acpPermission(probe)
    await acpQuestion(probe)
    await acpError(probe)
    await modelTurns(probe, "pi", PI)
    await cliTurns(probe, "claude", CLAUDE)
    await cliTurns(probe, "codex", CODEX)
    const file = await writeReport(renderReport({ records: probe.records, skipped: probe.skipped, startedAt }))
    console.log(`[probe] wrote ${file}`)
  } finally {
    await stack.close()
  }
}

await main()
