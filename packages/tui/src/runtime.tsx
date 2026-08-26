import path from "path"

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const flavor = /^[A-Za-z]:[\\/]|^\\\\/.test(home) || /^[A-Za-z]:[\\/]|^\\\\/.test(input) ? path.win32 : path.posix
  const relative = flavor.relative(home, input)
  if (relative === "") return "~"
  if (relative === ".." || relative.startsWith(".." + flavor.sep) || flavor.isAbsolute(relative)) return input
  return "~" + flavor.sep + relative
}
