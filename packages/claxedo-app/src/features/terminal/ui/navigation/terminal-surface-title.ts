export type TerminalSurfaceStatus = "idle" | "working" | "permission" | "done"

export function terminalSurfaceTitle(title: string, status: TerminalSurfaceStatus) {
  if (status === "working") return `${title} · working`
  if (status === "permission") return `${title} · needs input`
  if (status === "done") return `${title} · done`
  return title
}
