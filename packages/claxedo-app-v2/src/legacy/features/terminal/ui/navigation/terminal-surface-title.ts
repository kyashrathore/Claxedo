export type TerminalSurfaceStatus = "idle" | "working" | "permission" | "error" | "done"

export function terminalSurfaceTitle(title: string, status: TerminalSurfaceStatus) {
  if (status === "working") return `${title} · working`
  if (status === "permission") return `${title} · needs input`
  if (status === "error") return `${title} · failed`
  if (status === "done") return `${title} · done`
  return title
}
