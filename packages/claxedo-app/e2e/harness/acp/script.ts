import fs from "node:fs/promises"
import path from "node:path"
import type { PlanEntry, StopReason, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk"

export const ACP_SCRIPT_DIR_ENV = "SCRIPTED_ACP_DIR"
export const ACP_RED_ENV = "SCRIPTED_ACP_RED"

const SCRIPT_TOKEN = /acp-script:([A-Za-z0-9._-]+)/g

export type AcpToolStep = {
  kind: "tool"
  tool: ToolKind
  title: string
  id?: string
  input?: Record<string, unknown>
  output?: unknown
  text?: string
  locations?: ToolCallLocation[]
  content?: ToolCallContent[]
  status?: "completed" | "failed" | "in_progress"
}

export type AcpStep =
  | { kind: "text"; text: string; chunks?: number; delayMs?: number }
  | { kind: "reasoning"; text: string }
  | { kind: "image"; data: string; mimeType: string }
  | { kind: "plan"; entries: PlanEntry[] }
  | AcpToolStep
  | { kind: "diff"; path: string; oldText: string | null; newText: string; title?: string }
  | { kind: "permission"; tool: ToolKind; title: string; path?: string; input?: Record<string, unknown>; text?: string }
  | { kind: "question"; message: string; options?: string[] }
  | { kind: "subagent"; name: string; task: string; steps: AcpStep[] }
  | { kind: "hold"; name: string; ignoresCancel?: true }
  | { kind: "error"; message: string }
  | { kind: "stop"; reason: StopReason }

export type AcpScript = { steps: AcpStep[]; stopReason?: StopReason }

export function acpScriptToken(name: string) {
  return `acp-script:${name}`
}

export function lastAcpScriptName(text: string): string | undefined {
  return [...text.matchAll(SCRIPT_TOKEN)].at(-1)?.[1]
}

function scriptFile(dir: string, name: string) {
  return path.join(dir, `${name}.json`)
}

export function holdReleaseFile(dir: string, name: string) {
  return path.join(dir, `${name}.release`)
}

export async function writeAcpScript(dir: string, name: string, script: AcpScript) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(scriptFile(dir, name), JSON.stringify(script))
}

export async function readAcpScript(dir: string, name: string): Promise<AcpScript | undefined> {
  try {
    return JSON.parse(await fs.readFile(scriptFile(dir, name), "utf8")) as AcpScript
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export async function releaseAcpHold(dir: string, name: string) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(holdReleaseFile(dir, name), "released")
}
