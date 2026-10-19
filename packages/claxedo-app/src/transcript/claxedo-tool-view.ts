import type { TranscriptI18n, TranscriptTextKey } from "./i18n"
import { asArray, asRecord, nonEmptyString } from "@claxedo/helpers/guards"
import { jsonRecord } from "@claxedo/helpers"
import { readRecoveryPayloadLine, isRecoveryOutcome, isClaxedoToolName, parseRecoveryOutcome, turnStopped, type ClaxedoToolName } from "@claxedo/agent-runtime-contract"
import { clampLabel } from "./message-part-text"
import { toolCardFields, type ClaxedoFact, type ClaxedoLink, type ToolCardFields, type TranscriptToolCard } from "./tool-card-template"

export const CLAXEDO_TOOL_TITLE_KEYS: Partial<Record<ClaxedoToolName, TranscriptTextKey>> = {
  session_create: "transcript.claxedoTool.session_create",
  sessions_list: "transcript.claxedoTool.sessions_list",
  session_get: "transcript.claxedoTool.session_get",
  session_transcript: "transcript.claxedoTool.session_transcript",
  session_send: "transcript.claxedoTool.session_send",
  session_cancel_turn: "transcript.claxedoTool.session_cancel_turn",
  session_handoff: "transcript.claxedoTool.session_handoff",
  session_rename: "transcript.claxedoTool.session_rename",
  session_delete: "transcript.claxedoTool.session_delete",
  session_changes: "transcript.claxedoTool.session_changes",
  documents_list: "transcript.claxedoTool.documents_list",
  documents_open: "transcript.claxedoTool.documents_open",
  subagent_capabilities: "transcript.claxedoTool.subagent_capabilities",
  create_subagent: "transcript.claxedoTool.create_subagent",
  subagent_status: "transcript.claxedoTool.subagent_status",
  subagent_list: "transcript.claxedoTool.subagent_list",
  subagent_cancel: "transcript.claxedoTool.subagent_cancel",
  sessions_board: "transcript.claxedoTool.sessions_board",
  permission_reply: "transcript.claxedoTool.permission_reply",
  question_reply: "transcript.claxedoTool.question_reply",
  question_reject: "transcript.claxedoTool.question_reject",
  wait_for_attention: "transcript.claxedoTool.wait_for_attention",
  workspaces_list: "transcript.claxedoTool.workspaces_list",
  workspace_status: "transcript.claxedoTool.workspace_status",
  workspace_checkpoint: "transcript.claxedoTool.workspace_checkpoint",
  workspace_restore: "transcript.claxedoTool.workspace_restore",
  workspace_lifecycle: "transcript.claxedoTool.workspace_lifecycle",
  app_plugin_create: "transcript.claxedoTool.app_plugin_create",
  app_plugin_check: "transcript.claxedoTool.app_plugin_check",
  app_plugin_add: "transcript.claxedoTool.app_plugin_add",
  app_plugin_guide: "transcript.claxedoTool.app_plugin_guide",
  ui_show: "transcript.claxedoTool.ui_show",
  ui_guide: "transcript.claxedoTool.ui_guide",
}

export function claxedoToolArguments(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const nested = input?.arguments
  if (typeof nested === "string") return jsonRecord(nested) ?? {}
  return asRecord(nested) ?? input ?? {}
}

export function claxedoToolResult(output: string | undefined): Record<string, unknown> | undefined {
  const text = output?.trim()
  if (!text) return undefined
  const whole = jsonRecord(text)
  if (whole) return whole
  const marked = readRecoveryPayloadLine(text)
  return marked === undefined ? undefined : jsonRecord(marked)
}

export type ClaxedoToolView = ToolCardFields & {
  name: string
  title: string
  text?: string
}

export type ClaxedoToolViewInput = {
  name: string
  input: Record<string, unknown> | undefined
  output: string | undefined
  i18n: TranscriptI18n
  toolCards: readonly TranscriptToolCard[]
}

export function toolCardFor(name: string, toolCards: readonly TranscriptToolCard[]): TranscriptToolCard | undefined {
  return toolCards.find((card) => card.template.tool === name)
}

export function claxedoToolTitle(name: string, i18n: TranscriptI18n, toolCards: readonly TranscriptToolCard[]) {
  const key = isClaxedoToolName(name) ? CLAXEDO_TOOL_TITLE_KEYS[name] : undefined
  if (key) return i18n.t(key)
  return toolCardFor(name, toolCards)?.template.title ?? sentence(name)
}

export function claxedoToolView(view: ClaxedoToolViewInput): ClaxedoToolView {
  const { name, i18n } = view
  const args = claxedoToolArguments(view.input)
  const result = claxedoToolResult(view.output)
  const base: ClaxedoToolView = { name, title: claxedoToolTitle(name, i18n, view.toolCards), facts: [], rows: [] }
  const session = (id: string | undefined, label?: string): ClaxedoLink | undefined =>
    id ? { kind: "session", id, label: label ?? clampLabel(id, 28) } : undefined
  const count = (n: number, one: TranscriptTextKey, other: TranscriptTextKey) => `${n} ${i18n.t(n === 1 ? one : other)}`

  switch (name) {
    case "session_create": {
      const id = nonEmptyString(result?.id)
      const title = nonEmptyString(args.title)
      const worktree = asRecord(result?.worktree)
      return {
        ...base,
        ...(id ? { link: session(id, title) } : title ? { subject: title } : {}),
        ...(result?.prompted === true ? { note: i18n.t("transcript.claxedoTool.note.prompted") } : {}),
        facts: [
          ...(nonEmptyString(worktree?.name) ? [cardFact(i18n.t("transcript.claxedoTool.fact.worktree"), nonEmptyString(worktree?.name)!)] : []),
          ...(nonEmptyString(worktree?.directory) ? [cardFact(i18n.t("transcript.claxedoTool.fact.path"), nonEmptyString(worktree?.directory)!, { mono: true })] : []),
        ],
      }
    }
    case "session_send": {
      const message = nonEmptyString(args.text)
      return {
        ...base,
        link: session(nonEmptyString(args.session)),
        ...(result
          ? { note: i18n.t(result.admitted === false ? "transcript.claxedoTool.note.notAdmitted" : "transcript.claxedoTool.note.admitted") }
          : {}),
        facts: message ? [cardFact(i18n.t("transcript.claxedoTool.fact.message"), clampLabel(message, 160))] : [],
      }
    }
    case "session_rename":
      return { ...base, link: session(nonEmptyString(args.session)), ...(nonEmptyString(args.title) ? { subject: nonEmptyString(args.title) } : {}) }
    case "session_cancel_turn":
      return {
        ...base,
        link: session(nonEmptyString(args.session)),
        ...noteOf(i18n, cancellationNote(result?.cancellation)),
      }
    case "session_get":
    case "session_transcript":
    case "session_handoff":
    case "session_delete":
      return { ...base, link: session(nonEmptyString(args.session)) }
    case "session_changes":
      return { ...base, link: session(nonEmptyString(args.session)), ...prose(view.output) }
    case "sessions_list": {
      const sessions = asArray(result?.workspaces).flatMap((row) => asArray(asRecord(row)?.sessions))
      return { ...base, ...(result ? { subject: count(sessions.length, "transcript.common.session.one", "transcript.common.session.other") } : {}) }
    }
    case "documents_list": {
      const documents = asArray(result?.documents)
      return { ...base, ...(result ? { subject: count(documents.length, "transcript.common.document.one", "transcript.common.document.other") } : {}) }
    }
    case "documents_open": {
      const path = nonEmptyString(result?.path)
      return {
        ...base,
        subject: nonEmptyString(result?.name) ?? nonEmptyString(args.document),
        facts: [
          ...(path ? [cardFact(i18n.t("transcript.claxedoTool.fact.path"), path, { mono: true })] : []),
          ...linkFact(i18n.t("transcript.claxedoTool.fact.session"), session(nonEmptyString(result?.session))),
        ],
      }
    }
    case "create_subagent":
    case "subagent_status":
    case "subagent_cancel": {
      const id = nonEmptyString(result?.sessionId) ?? nonEmptyString(args.sessionId)
      return {
        ...base,
        ...(id ? { link: session(id) } : nonEmptyString(args.subagentKey) ? { subject: nonEmptyString(args.subagentKey) } : {}),
        ...(nonEmptyString(result?.status) ? { note: nonEmptyString(result?.status) } : {}),
      }
    }
    case "permission_reply":
      return { ...base, subject: nonEmptyString(args.response), link: session(nonEmptyString(args.session)) }
    case "question_reply":
    case "question_reject":
      return { ...base, link: session(nonEmptyString(args.session)), ...prose(view.output) }
    case "workspace_lifecycle":
      return { ...base, subject: nonEmptyString(args.action) ?? nonEmptyString(args.state), ...prose(view.output) }
    case "sessions_board":
    case "wait_for_attention":
    case "workspaces_list":
    case "workspace_status":
    case "workspace_checkpoint":
    case "workspace_restore":
    case "subagent_capabilities":
    case "subagent_list":
      return { ...base, ...prose(view.output) }
    default: {
      const card = toolCardFor(name, view.toolCards)
      if (card) return { ...base, ...toolCardFields(card, { args, result }) }
      return { ...base, subject: firstLabel(args), ...prose(view.output) }
    }
  }
}

function noteOf(i18n: TranscriptI18n, key: TranscriptTextKey | undefined) {
  return key ? { note: i18n.t(key) } : {}
}

function cancellationNote(answer: unknown) {
  if (!isRecoveryOutcome(answer)) return undefined
  const outcome = parseRecoveryOutcome(answer)
  if (outcome.kind === "refused") {
    return outcome.refusal.kind === "generation_conflict"
      ? ("transcript.claxedoTool.note.notRunning" as const)
      : ("transcript.claxedoTool.note.notStopped" as const)
  }
  if (!turnStopped(outcome)) return "transcript.claxedoTool.note.notStopped" as const
  return outcome.operation.facts.cleanup.value === "verified_clear"
    ? ("transcript.claxedoTool.note.stopped" as const)
    : ("transcript.claxedoTool.note.cleanupUnverified" as const)
}

function cardFact(label: string, value: string | ClaxedoLink, options?: { mono?: boolean }): ClaxedoFact {
  if (typeof value === "string") return { label, value, ...(options?.mono ? { mono: true } : {}) }
  return { label, value: value.label, link: value }
}

function linkFact(label: string, link: ClaxedoLink | undefined): ClaxedoFact[] {
  return link ? [cardFact(label, link)] : []
}

function prose(output: string | undefined): { text?: string } {
  const trimmed = output?.trim()
  return trimmed ? { text: trimmed } : {}
}

const LABEL_KEYS = ["title", "name", "session", "task", "document", "workspace", "query", "text", "prompt"]

function firstLabel(args: Record<string, unknown>) {
  for (const key of LABEL_KEYS) {
    const value = nonEmptyString(args[key])
    if (value) return clampLabel(value)
  }
  return undefined
}

function sentence(name: string) {
  const words = name.split(/[_\s-]+/).filter((word) => word.length > 0)
  if (words.length === 0) return name
  return words.map((word, index) => (index === 0 ? word[0].toUpperCase() + word.slice(1) : word)).join(" ")
}

