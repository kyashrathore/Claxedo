import { nonEmptyString } from "@claxedo/helpers/guards"

/**
 * Harnesses spell the same tool differently: Claude sends `Bash`/`LS`/`Agent`, Codex
 * sends `command`/`read_file`, OpenCode sends `bash`/`read`. Everything downstream —
 * the grouping vocabularies, the renderer registry, `getToolInfo`, the subagent
 * predicate — matches one lowercase spelling, so a name is canonicalised once at the
 * boundary that mints a part rather than at each of those readers.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  agent: "task",
  subagent: "task",
  spawn_agent: "task",
  spawnagent: "task",
  create_subagent: "task",
  mcp__claxedo__create_subagent: "task",
  claxedo_create_subagent: "task",
  command: "bash",
  shell: "bash",
  local_shell: "bash",
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  // `multiedit` has no entry: the `edit` renderer draws its diff from
  // `metadata.filediff` or `input.oldString`/`newString`, and claude's `MultiEdit`
  // sends neither — only `{file_path, edits: []}`. Aliased it renders an empty diff
  // that claims nothing changed; unaliased the generic row at least dumps the input.
  ls: "list",
  askuserquestion: "question",
  createplan: "exitplanmode",
  web_search: "websearch",
}

export function canonicalToolName(name: string) {
  const lowered = name.toLowerCase()
  return Object.hasOwn(TOOL_NAME_ALIASES, lowered) ? TOOL_NAME_ALIASES[lowered]! : lowered
}

/** The alias spellings themselves, for consumers that register one entry per name. */
export function toolNameAliases(): ReadonlyArray<readonly [alias: string, target: string]> {
  return Object.entries(TOOL_NAME_ALIASES)
}

const CLAXEDO_MCP_SERVER = "claxedo"

const CLAXEDO_TOOL_NAMES = [
  "task_list",
  "task_get",
  "task_create",
  "task_edit",
  "task_start",
  "session_create",
  "sessions_list",
  "session_get",
  "session_transcript",
  "session_send",
  "session_cancel_turn",
  "session_handoff",
  "session_rename",
  "session_delete",
  "session_changes",
  "documents_list",
  "documents_open",
  "processes",
  "process_start",
  "process_stop",
  "process_logs",
  "subagent_capabilities",
  "create_subagent",
  "subagent_status",
  "subagent_list",
  "subagent_cancel",
  "sessions_board",
  "permission_reply",
  "question_reply",
  "question_reject",
  "wait_for_attention",
  "workspaces_list",
  "workspace_status",
  "workspace_checkpoint",
  "workspace_restore",
  "workspace_lifecycle",
  "app_plugin_create",
  "app_plugin_check",
  "app_plugin_add",
  "app_plugin_guide",
] as const

export type ClaxedoToolName = (typeof CLAXEDO_TOOL_NAMES)[number]

const CLAXEDO_TOOL_NAME_SET: ReadonlySet<string> = new Set(CLAXEDO_TOOL_NAMES)

export function isClaxedoToolName(name: string): name is ClaxedoToolName {
  return CLAXEDO_TOOL_NAME_SET.has(name)
}

export function claxedoToolName(tool: string, input?: Record<string, unknown>): string | undefined {
  const lowered = tool.toLowerCase()
  for (const server of ["claxedo-mcp", CLAXEDO_MCP_SERVER]) {
    const wrapped = `mcp__${server}__`
    if (lowered.startsWith(wrapped)) return lowered.slice(wrapped.length) || undefined
    const joined = `${server}_`
    if (lowered.startsWith(joined)) {
      const name = lowered.slice(joined.length)
      if (isClaxedoToolName(name) || (server === "claxedo-mcp" && name)) return name
    }
    if (typeof input?.server === "string" && input.server.toLowerCase() === server) {
      return nonEmptyString(input.tool)?.toLowerCase() ?? lowered
    }
  }
  return undefined
}
