import type { UiI18n, UiI18nKey } from "@opencode-ai/ui/context/i18n"
import { asArray, asFiniteNumber, asRecord, nonEmptyString } from "@claxedo/helpers/guards"
import { jsonRecord } from "@claxedo/helpers"
import { clampLabel } from "./message-part-text"

export const CLAXEDO_MCP_SERVER = "claxedo"

/**
 * Every tool the first-party MCP registers, with the row title each one reads
 * as. The key set doubles as the roster: an engine-prefixed `claxedo_<name>`
 * is only claimed when `<name>` is here, because that spelling carries no
 * server on the input to prove it addressed this server.
 */
export const CLAXEDO_TOOL_TITLE_KEYS = {
  task_list: "ui.claxedoTool.task_list",
  task_get: "ui.claxedoTool.task_get",
  task_create: "ui.claxedoTool.task_create",
  task_edit: "ui.claxedoTool.task_edit",
  task_start: "ui.claxedoTool.task_start",
  session_create: "ui.claxedoTool.session_create",
  sessions_list: "ui.claxedoTool.sessions_list",
  session_get: "ui.claxedoTool.session_get",
  session_transcript: "ui.claxedoTool.session_transcript",
  session_send: "ui.claxedoTool.session_send",
  session_abort: "ui.claxedoTool.session_abort",
  session_handoff: "ui.claxedoTool.session_handoff",
  session_rename: "ui.claxedoTool.session_rename",
  session_delete: "ui.claxedoTool.session_delete",
  session_changes: "ui.claxedoTool.session_changes",
  documents_list: "ui.claxedoTool.documents_list",
  documents_open: "ui.claxedoTool.documents_open",
  processes: "ui.claxedoTool.processes",
  process_start: "ui.claxedoTool.process_start",
  process_stop: "ui.claxedoTool.process_stop",
  process_logs: "ui.claxedoTool.process_logs",
  subagent_capabilities: "ui.claxedoTool.subagent_capabilities",
  create_subagent: "ui.claxedoTool.create_subagent",
  subagent_status: "ui.claxedoTool.subagent_status",
  subagent_list: "ui.claxedoTool.subagent_list",
  subagent_cancel: "ui.claxedoTool.subagent_cancel",
  sessions_board: "ui.claxedoTool.sessions_board",
  permission_reply: "ui.claxedoTool.permission_reply",
  question_reply: "ui.claxedoTool.question_reply",
  question_reject: "ui.claxedoTool.question_reject",
  wait_for_attention: "ui.claxedoTool.wait_for_attention",
  workspaces_list: "ui.claxedoTool.workspaces_list",
  workspace_status: "ui.claxedoTool.workspace_status",
  workspace_checkpoint: "ui.claxedoTool.workspace_checkpoint",
  workspace_restore: "ui.claxedoTool.workspace_restore",
  workspace_lifecycle: "ui.claxedoTool.workspace_lifecycle",
} as const satisfies Record<string, UiI18nKey>

export type ClaxedoToolName = keyof typeof CLAXEDO_TOOL_TITLE_KEYS

export function isClaxedoToolName(name: string): name is ClaxedoToolName {
  return Object.prototype.hasOwnProperty.call(CLAXEDO_TOOL_TITLE_KEYS, name)
}

/**
 * The bare first-party tool a part calls, or nothing when the part is not one.
 *
 * Each harness spells the same MCP tool differently. Claude wraps it as
 * `mcp__claxedo__task_create`; Codex sends the bare `task_create` and names
 * the server on the input (`input.server`); the embedded OpenCode engine joins
 * server and tool with one underscore, `claxedo_task_create`, and puts nothing
 * on the input. The first two carry the server explicitly, so any name they
 * address to it is claimed; the engine spelling is claimed only for a name in
 * the roster, since `claxedo_` alone cannot tell this server's tool from
 * another server's tool that happens to start with the word.
 */
export function claxedoToolName(tool: string, input?: Record<string, unknown>): string | undefined {
  const lowered = tool.toLowerCase()
  const wrapped = `mcp__${CLAXEDO_MCP_SERVER}__`
  if (lowered.startsWith(wrapped)) return lowered.slice(wrapped.length) || undefined
  const server = input?.server
  if (typeof server === "string" && server.toLowerCase() === CLAXEDO_MCP_SERVER) return lowered
  const joined = `${CLAXEDO_MCP_SERVER}_`
  if (lowered.startsWith(joined) && isClaxedoToolName(lowered.slice(joined.length))) return lowered.slice(joined.length)
  return undefined
}

/**
 * The arguments the tool was called with. Codex reports an MCP call as
 * `{server, tool, arguments}`, so the fields a card reads sit one level down
 * there and at the top level everywhere else.
 */
export function claxedoToolArguments(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const nested = input?.arguments
  if (typeof nested === "string") return jsonRecord(nested) ?? {}
  return asRecord(nested) ?? input ?? {}
}

/**
 * The tool's JSON answer, or nothing when the output is prose or a refusal.
 * The projection only ever hands the card a string, so the structured result
 * has to be recovered from it.
 */
export function claxedoToolResult(output: string | undefined): Record<string, unknown> | undefined {
  return jsonRecord(output?.trim())
}

export type ClaxedoLink = { kind: "task" | "session"; id: string; label: string }

export type ClaxedoFact = { label: string; value: string; link?: ClaxedoLink; mono?: boolean }

export type ClaxedoTaskRow = { link: ClaxedoLink; status?: string }

export type ClaxedoToolView = {
  name: string
  title: string
  /** What the call was about, when it is not a link. */
  subject?: string
  /** What the call was about, as a link to the task or session. */
  link?: ClaxedoLink
  /** A task status, shown as a pill beside the subject. */
  status?: string
  /** A trailing aside: the call was replayed, the session was already running. */
  note?: string
  facts: ClaxedoFact[]
  rows: ClaxedoTaskRow[]
  /** What the row list leaves out: a count past the cap, or a further page. */
  more?: string
  /** A prose answer, shown as it came. */
  text?: string
}

export type ClaxedoToolViewInput = {
  name: string
  input: Record<string, unknown> | undefined
  output: string | undefined
  i18n: UiI18n
  /** A session's title when the transcript already knows it, so a link can read as one. */
  sessionTitle?: (sessionId: string) => string | undefined
}

const TASK_STATUS_KEYS: Record<string, UiI18nKey> = {
  backlog: "ui.claxedoTool.status.backlog",
  todo: "ui.claxedoTool.status.todo",
  doing: "ui.claxedoTool.status.doing",
  needs_you: "ui.claxedoTool.status.needs_you",
  done: "ui.claxedoTool.status.done",
}

export function taskStatusLabel(status: string, i18n: UiI18n) {
  const key = TASK_STATUS_KEYS[status]
  return key ? i18n.t(key) : status.replaceAll("_", " ")
}

/** Rows a task list shows before folding the rest behind a count. */
export const TASK_LIST_ROW_CAP = 8

export function claxedoToolTitle(name: string, i18n: UiI18n) {
  if (isClaxedoToolName(name)) return i18n.t(CLAXEDO_TOOL_TITLE_KEYS[name])
  return sentence(name)
}

export function claxedoToolView(view: ClaxedoToolViewInput): ClaxedoToolView {
  const { name, i18n } = view
  const args = claxedoToolArguments(view.input)
  const result = claxedoToolResult(view.output)
  const base: ClaxedoToolView = { name, title: claxedoToolTitle(name, i18n), facts: [], rows: [] }
  const session = (id: string | undefined, label?: string): ClaxedoLink | undefined =>
    id ? { kind: "session", id, label: label ?? view.sessionTitle?.(id) ?? clampLabel(id, 28) } : undefined
  const count = (n: number, one: UiI18nKey, other: UiI18nKey) => `${n} ${i18n.t(n === 1 ? one : other)}`

  switch (name) {
    case "task_create": {
      const task = asRecord(result?.task)
      const status = nonEmptyString(task?.status) ?? nonEmptyString(args.status) ?? "todo"
      const parent = nonEmptyString(task?.parent) ?? nonEmptyString(args.parent)
      const from = asRecord(task?.createdFrom)
      const link = task
        ? taskLink(nonEmptyString(task.id), nonEmptyString(task.key), nonEmptyString(task.title))
        : undefined
      return {
        ...base,
        ...(link ? { link } : { subject: nonEmptyString(args.title) }),
        status,
        ...(result?.replayed === true ? { note: i18n.t("ui.claxedoTool.note.replayed") } : {}),
        facts: [
          ...(parent ? [cardFact(i18n.t("ui.claxedoTool.fact.parent"), taskLink(parent))] : []),
          ...linkFact(i18n.t("ui.claxedoTool.fact.createdFrom"), session(nonEmptyString(from?.sessionId))),
        ],
      }
    }
    case "task_edit": {
      const task = asRecord(result?.task)
      const link = task
        ? taskLink(nonEmptyString(task.id), nonEmptyString(task.key), nonEmptyString(task.title))
        : taskLink(nonEmptyString(args.task))
      return {
        ...base,
        ...(link ? { link } : { subject: nonEmptyString(args.title) }),
        ...(nonEmptyString(task?.status) ? { status: nonEmptyString(task?.status) } : {}),
        ...(result?.replayed === true ? { note: i18n.t("ui.claxedoTool.note.replayed") } : {}),
        facts: [],
      }
    }
    case "task_start": {
      const task = asRecord(result?.task)
      const preset = nonEmptyString(asRecord(result?.preset)?.name) ?? nonEmptyString(args.preset)
      const started = session(nonEmptyString(asRecord(result?.session)?.sessionId))
      const slot = nonEmptyString(result?.slot) ?? nonEmptyString(args.slot)
      const attempt = asFiniteNumber(result?.attempt)
      const placement = nonEmptyString(result?.placement)
      const destination = nonEmptyString(result?.destination)
      return {
        ...base,
        link: taskLink(nonEmptyString(task?.id) ?? nonEmptyString(args.task), nonEmptyString(task?.key), nonEmptyString(task?.title)),
        ...(preset ? { subject: preset } : {}),
        ...(result?.created === false
          ? { note: i18n.t("ui.claxedoTool.note.alreadyRunning") }
          : args.continue === true
            ? { note: i18n.t("ui.claxedoTool.note.continued") }
            : {}),
        facts: [
          ...linkFact(i18n.t("ui.claxedoTool.fact.session"), started),
          ...(preset ? [cardFact(i18n.t("ui.claxedoTool.fact.preset"), preset)] : []),
          ...(slot ? [cardFact(i18n.t("ui.claxedoTool.fact.slot"), slot)] : []),
          ...(attempt !== undefined ? [cardFact(i18n.t("ui.claxedoTool.fact.attempt"), String(attempt))] : []),
          ...(placement ? [cardFact(i18n.t("ui.claxedoTool.fact.placement"), placement)] : []),
          ...(destination ? [cardFact(i18n.t("ui.claxedoTool.fact.destination"), destination, { mono: true })] : []),
        ],
      }
    }
    case "task_get": {
      const task = asRecord(result?.task)
      const links = asArray(result?.links)
      const parent = nonEmptyString(task?.parentTaskId) ?? nonEmptyString(task?.parent)
      const children = asRecord(task?.children)
      return {
        ...base,
        link: taskLink(nonEmptyString(task?.id) ?? nonEmptyString(args.task), nonEmptyString(task?.key), nonEmptyString(task?.title)),
        ...(nonEmptyString(task?.status) ? { status: nonEmptyString(task?.status) } : {}),
        facts: [
          ...(parent ? [cardFact(i18n.t("ui.claxedoTool.fact.parent"), taskLink(parent))] : []),
          ...(children
            ? [cardFact(i18n.t("ui.claxedoTool.fact.subtasks"), count(asFiniteNumber(children.total) ?? 0, "ui.common.subtask.one", "ui.common.subtask.other"))]
            : []),
          ...(result ? [cardFact(i18n.t("ui.claxedoTool.fact.sessions"), count(links.length, "ui.common.session.one", "ui.common.session.other"))] : []),
        ],
      }
    }
    case "task_list": {
      const tasks = asArray(result?.tasks).flatMap((row) => {
        const task = asRecord(row)
        const id = nonEmptyString(task?.id)
        if (!task || !id) return []
        return [{ link: taskLink(id, nonEmptyString(task.key), nonEmptyString(task.title)), ...(nonEmptyString(task.status) ? { status: nonEmptyString(task.status) } : {}) }]
      })
      const filter = nonEmptyString(args.status)
      const hidden = Math.max(0, tasks.length - TASK_LIST_ROW_CAP)
      return {
        ...base,
        ...(result ? { subject: count(tasks.length, "ui.common.task.one", "ui.common.task.other") } : {}),
        ...(filter ? { status: filter } : {}),
        rows: tasks.slice(0, TASK_LIST_ROW_CAP),
        ...(hidden > 0
          ? { more: i18n.t("ui.claxedoTool.more", { count: hidden }) }
          : nonEmptyString(result?.nextCursor)
            ? { more: i18n.t("ui.claxedoTool.moreAvailable") }
            : {}),
      }
    }
    case "session_create": {
      const id = nonEmptyString(result?.id)
      const title = nonEmptyString(args.title)
      const worktree = asRecord(result?.worktree)
      return {
        ...base,
        ...(id ? { link: session(id, title) } : title ? { subject: title } : {}),
        ...(result?.prompted === true ? { note: i18n.t("ui.claxedoTool.note.prompted") } : {}),
        facts: [
          ...(nonEmptyString(worktree?.name) ? [cardFact(i18n.t("ui.claxedoTool.fact.worktree"), nonEmptyString(worktree?.name)!)] : []),
          ...(nonEmptyString(worktree?.directory) ? [cardFact(i18n.t("ui.claxedoTool.fact.path"), nonEmptyString(worktree?.directory)!, { mono: true })] : []),
        ],
      }
    }
    case "session_send": {
      const message = nonEmptyString(args.text)
      return {
        ...base,
        link: session(nonEmptyString(args.session)),
        ...(result
          ? { note: i18n.t(result.admitted === false ? "ui.claxedoTool.note.notAdmitted" : "ui.claxedoTool.note.admitted") }
          : {}),
        facts: message ? [cardFact(i18n.t("ui.claxedoTool.fact.message"), clampLabel(message, 160))] : [],
      }
    }
    case "session_rename":
      return { ...base, link: session(nonEmptyString(args.session)), ...(nonEmptyString(args.title) ? { subject: nonEmptyString(args.title) } : {}) }
    case "session_abort":
      return {
        ...base,
        link: session(nonEmptyString(args.session)),
        ...(result ? { note: i18n.t(result.aborted === false ? "ui.claxedoTool.note.notRunning" : "ui.claxedoTool.note.stopped") } : {}),
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
      return { ...base, ...(result ? { subject: count(sessions.length, "ui.common.session.one", "ui.common.session.other") } : {}) }
    }
    case "documents_list": {
      const documents = asArray(result?.documents)
      return { ...base, ...(result ? { subject: count(documents.length, "ui.common.document.one", "ui.common.document.other") } : {}) }
    }
    case "documents_open": {
      const path = nonEmptyString(result?.path)
      return {
        ...base,
        subject: nonEmptyString(result?.name) ?? nonEmptyString(args.document),
        facts: [
          ...(path ? [cardFact(i18n.t("ui.claxedoTool.fact.path"), path, { mono: true })] : []),
          ...linkFact(i18n.t("ui.claxedoTool.fact.session"), session(nonEmptyString(result?.session))),
        ],
      }
    }
    case "process_start":
    case "process_logs":
      return { ...base, subject: nonEmptyString(args.process) ?? nonEmptyString(args.name), ...prose(view.output) }
    case "process_stop":
      return {
        ...base,
        subject: nonEmptyString(args.process),
        ...(result ? { note: i18n.t(result.stopped === false ? "ui.claxedoTool.note.notRunning" : "ui.claxedoTool.note.stopped") } : {}),
      }
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
    case "processes":
    case "sessions_board":
    case "wait_for_attention":
    case "workspaces_list":
    case "workspace_status":
    case "workspace_checkpoint":
    case "workspace_restore":
    case "subagent_capabilities":
    case "subagent_list":
      return { ...base, ...prose(view.output) }
    default:
      return { ...base, subject: firstLabel(args), ...prose(view.output) }
  }
}

function taskLink(id: string | undefined, key?: string, title?: string): ClaxedoLink {
  const label = key && title
    ? `#${key} ${title}`
    : key
      ? `#${key}`
      : title ?? (id && /^\d+$/.test(id) ? `#${id}` : clampLabel(id ?? "", 13))
  return { kind: "task", id: id ?? "", label }
}

function cardFact(label: string, value: string | ClaxedoLink, options?: { mono?: boolean }): ClaxedoFact {
  if (typeof value === "string") return { label, value, ...(options?.mono ? { mono: true } : {}) }
  return { label, value: value.label, link: value }
}

function linkFact(label: string, link: ClaxedoLink | undefined): ClaxedoFact[] {
  return link ? [cardFact(label, link)] : []
}

/** Output that is prose, or JSON the card has no shape for: shown as it came. */
function prose(output: string | undefined): { text?: string } {
  const trimmed = output?.trim()
  return trimmed ? { text: trimmed } : {}
}

const LABEL_KEYS = ["title", "name", "session", "task", "process", "document", "workspace", "query", "text", "prompt"]

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

