import { asRecord } from "@claxedo/helpers/guards"
import type { AgentToolPart, AgentToolState } from "./content"
import { canonicalToolName, claxedoToolName } from "./tool-names"

export type ToolOpenSettings = { readonly shell: boolean; readonly edit: boolean }

export function toolOpensByDefault(tool: string, settings: ToolOpenSettings): boolean | undefined {
  const name = canonicalToolName(tool)
  if (name === "bash") return settings.shell
  if (name === "edit" || name === "write" || name === "apply_patch") return settings.edit
  return undefined
}

type Fields = Record<string, unknown>

type HeaderShape = {
  readonly input: readonly string[]
  readonly metadata?: (metadata: Fields) => Fields
}

function fieldsNamed(value: Fields, keys: readonly string[]): Fields {
  return Object.fromEntries(keys.flatMap((key) => (Object.hasOwn(value, key) ? [[key, value[key]]] : [])))
}

const metadataNamed = (...keys: string[]) => (metadata: Fields) => fieldsNamed(metadata, keys)

const DIFF_COUNTS = ["file", "filePath", "relativePath", "type", "movePath", "additions", "deletions"]

function diffCounts(value: unknown): Fields | undefined {
  const record = asRecord(value)
  return record && fieldsNamed(record, DIFF_COUNTS)
}

/**
 * The input and metadata each tool row draws while collapsed, by canonical
 * tool name. A tool missing here keeps its whole input, because a generic row
 * lists its input as arguments. The transcript's renderers are the readers
 * these lists must match.
 */
const HEADERS: Readonly<Record<string, HeaderShape>> = {
  read: { input: ["filePath", "offset", "limit"], metadata: metadataNamed("loaded") },
  list: { input: ["path"] },
  glob: { input: ["path", "pattern"] },
  grep: { input: ["path", "pattern", "include"] },
  webfetch: { input: ["url"] },
  websearch: { input: ["query"], metadata: metadataNamed("provider") },
  bash: { input: ["command"], metadata: metadataNamed("command", "exitCode") },
  edit: {
    input: ["filePath", "path"],
    metadata: (metadata) => {
      const filediff = diffCounts(metadata.filediff)
      return filediff ? { filediff } : {}
    },
  },
  write: { input: ["filePath", "path"] },
  apply_patch: {
    input: [],
    metadata: (metadata) => (Array.isArray(metadata.files) ? { files: metadata.files.flatMap((file) => diffCounts(file) ?? []) } : {}),
  },
  todowrite: { input: [] },
  skill: { input: ["name", "skill"] },
  enterplanmode: { input: [] },
}

/** Tools whose row has nothing to collapse, so the whole part is its header. */
const WHOLE = new Set(["question", "exitplanmode", "task"])

/**
 * First-party Claxedo tools whose collapsed row reads their result (a task or
 * session link, a status, a count or a note), so the whole part is its header.
 * Their results are small records; the others, whose rows read only their
 * input, can answer a transcript, a log or a diff. `claxedoToolView` in the
 * app's transcript is the reader this list must match.
 */
const CLAXEDO_RESULT_ROWS = new Set([
  "task_create",
  "task_edit",
  "task_start",
  "task_get",
  "task_list",
  "session_create",
  "session_send",
  "session_cancel_turn",
  "sessions_list",
  "documents_list",
  "documents_open",
  "create_subagent",
  "subagent_status",
  "subagent_cancel",
])

const ALWAYS_KEPT_INPUT = ["intent"]

function headerState(state: AgentToolState, shape: HeaderShape | undefined): AgentToolState {
  const input = shape ? fieldsNamed(state.input, [...shape.input, ...ALWAYS_KEPT_INPUT]) : state.input
  const metadata = (value: Fields | undefined) => (value && shape?.metadata ? shape.metadata(value) : {})
  switch (state.status) {
    case "pending":
      return { status: "pending", input, raw: "" }
    case "running":
      return { status: "running", input, time: state.time, metadata: metadata(state.metadata), ...(state.title === undefined ? {} : { title: state.title }) }
    case "completed":
      return {
        status: "completed",
        input,
        output: "",
        title: state.title,
        metadata: metadata(state.metadata),
        time: state.time,
      }
    case "error":
      return { status: "error", input, error: state.error, metadata: metadata(state.metadata), time: state.time }
  }
}

/**
 * A tool part as its collapsed row draws it: status, title, time, error and
 * the input and metadata its header reads, marked `headerOnly` so a reader
 * fetches the whole part, attachments included, when the row opens. A tool
 * whose row has no body is returned whole.
 */
export function toolPartHeader(part: AgentToolPart): AgentToolPart {
  const name = canonicalToolName(part.tool)
  if (WHOLE.has(name) || CLAXEDO_RESULT_ROWS.has(claxedoToolName(part.tool, part.state.input) ?? "")) return part
  return { ...part, state: headerState(part.state, HEADERS[name]), headerOnly: true }
}
