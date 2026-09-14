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
  web_search: "websearch",
}

export function canonicalToolName(name: string) {
  const lowered = name.toLowerCase()
  return TOOL_NAME_ALIASES[lowered] ?? lowered
}

/** The alias spellings themselves, for consumers that register one entry per name. */
export function toolNameAliases(): ReadonlyArray<readonly [alias: string, target: string]> {
  return Object.entries(TOOL_NAME_ALIASES)
}
