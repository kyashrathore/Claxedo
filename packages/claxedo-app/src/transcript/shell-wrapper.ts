const SHELL_WRAPPER = /^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish)\s+(?:-\w+\s+)*-\w*c\s+([\s\S]+)$/i

function unquoteScript(value: string) {
  const quote = value[0]
  if ((quote === "'" || quote === '"') && value.length > 1 && value.endsWith(quote)) return value.slice(1, -1)
  return value
}

export function stripShellWrapper(command: string): string {
  const trimmed = command.trim()
  const match = trimmed.match(SHELL_WRAPPER)
  if (!match?.[1]) return trimmed
  return unquoteScript(match[1].trim()).trim()
}
