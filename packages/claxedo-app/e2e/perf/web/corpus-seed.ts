import fs from "node:fs/promises"
import path from "node:path"
import type { ToolKind } from "@agentclientprotocol/sdk"
import { SCRIPTED_ACP_HARNESS } from "../../../../harness/e2e/harness/acp/connection"
import { acpScriptToken, type AcpScript, type AcpStep } from "../../../../harness/e2e/harness/acp/script"
import type { ClaxedoApi } from "../../harness/api"

const FIXTURE = path.join(import.meta.dirname, "../../corpus/seeds/transcript-lab-fixture.json")
const ORDER = ["cfdeploy", "landing", "toolrun", "diagnosis", "onboarding"]
const PROMPT_CHARS = 1200

type FixturePart = {
  type: string
  text?: string
  tool?: string
  state?: { status?: string; input?: Record<string, unknown>; output?: unknown; title?: string }
}
type FixtureSession = { id: string; messages: { id: string; role: string }[]; parts: Record<string, FixturePart[]> }
type FixtureTurn = { prompt: string; steps: AcpStep[]; bytes: number }

const TOOL_KINDS: Record<string, ToolKind> = { bash: "execute", read: "read", write: "edit", edit: "edit", grep: "search", glob: "search", toolsearch: "search", webfetch: "fetch" }

function toolStep(part: FixturePart): AcpStep {
  const state = part.state ?? {}
  const description = typeof state.input?.description === "string" ? state.input.description : undefined
  const output = typeof state.output === "string" ? state.output : JSON.stringify(state.output ?? "")
  return {
    kind: "tool",
    tool: TOOL_KINDS[part.tool ?? ""] ?? "other",
    title: state.title || description || part.tool || "tool",
    input: state.input ?? {},
    text: output,
    status: state.status === "error" ? "failed" : "completed",
  }
}

function partStep(part: FixturePart): AcpStep | undefined {
  if (part.type === "text" && part.text) return { kind: "text", text: part.text }
  if (part.type === "reasoning" && part.text) return { kind: "reasoning", text: part.text }
  if (part.type === "tool") return toolStep(part)
  return undefined
}

function sessionTurns(session: FixtureSession): FixtureTurn[] {
  const turns: FixtureTurn[] = []
  for (const message of session.messages) {
    const parts = session.parts[message.id] ?? []
    if (message.role === "user") {
      const prompt = parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n").slice(0, PROMPT_CHARS)
      turns.push({ prompt: prompt || "Continue.", steps: [], bytes: 0 })
      continue
    }
    const turn = turns.at(-1)
    if (!turn) continue
    for (const part of parts) {
      const step = partStep(part)
      if (!step) continue
      turn.steps.push(step)
      turn.bytes += JSON.stringify(part).length
    }
  }
  return turns.filter((turn) => turn.steps.length > 0)
}

async function corpusTurns() {
  const sessions = JSON.parse(await fs.readFile(FIXTURE, "utf8")) as FixtureSession[]
  return ORDER.flatMap((id) => {
    const session = sessions.find((candidate) => candidate.id === id)
    if (!session) throw new Error(`the transcript fixture has no ${id} session`)
    return sessionTurns(session)
  })
}

export async function corpusPlan(targetBytes: number, endText: string) {
  const all = await corpusTurns()
  const plan: FixtureTurn[] = []
  let bytes = 0
  for (let index = 0; bytes < targetBytes; index += 1) {
    const turn = all[index % all.length]
    if (!turn) throw new Error("the transcript fixture has no turns")
    plan.push(turn)
    bytes += turn.bytes
  }
  const last = plan.at(-1)
  if (last) plan[plan.length - 1] = { ...last, steps: [...last.steps, { kind: "text", text: endText }] }
  return { turns: plan, bytes }
}

export async function seedCorpusSession(input: {
  api: ClaxedoApi
  directory: string
  title: string
  targetBytes: number
  endText: string
  writeScript: (name: string, script: AcpScript) => Promise<void>
}) {
  const plan = await corpusPlan(input.targetBytes, input.endText)
  const session = await input.api.createSession(input.directory, { title: input.title, harness: SCRIPTED_ACP_HARNESS })
  for (const [index, turn] of plan.turns.entries()) {
    const script = `${input.title.replace(/[^A-Za-z0-9]+/g, "-")}-${index}`
    await input.writeScript(script, { steps: turn.steps })
    await input.api.prompt(input.directory, session.id, `${turn.prompt}\n${acpScriptToken(script)}`)
  }
  return { sessionId: session.id, turns: plan.turns.length, fixtureBytes: plan.bytes }
}
