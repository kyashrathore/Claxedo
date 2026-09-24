const SHELL_WRAPPER = /^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish)\s+(?:-\w+\s+)*-\w*c\s+([\s\S]+)$/i

function unquoteScript(value: string) {
  const quote = value[0]
  if ((quote === "'" || quote === '"') && value.length > 1 && value.endsWith(quote)) return value.slice(1, -1)
  return value
}

/**
 * Harnesses run shell tools through a login-shell wrapper — Codex sends
 * `/bin/zsh -lc '<script>'`. That prefix is identical on every single call, so showing it
 * burns the row on boilerplate and pushes the part you actually want to read off the end.
 * Display the inner script instead (D§3.3: the trailing detail IS the command).
 */
export function stripShellWrapper(command: string): string {
  const trimmed = command.trim()
  const match = trimmed.match(SHELL_WRAPPER)
  if (!match?.[1]) return trimmed
  return unquoteScript(match[1].trim()).trim()
}
