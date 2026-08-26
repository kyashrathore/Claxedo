export type LocalPTY = {
  id: string
  title: string
  titleNumber: number
  cwd?: string
  rows?: number
  cols?: number
  buffer?: string
  modeSequences?: string
  wasAltScreen?: boolean
  wasAtBottom?: boolean
  scrollY?: number
  cursor?: number
  initialCommand?: string
  /**
   * Set when this entry points at a PTY the server just created to replace a
   * lost one (the `clone()` recovery after WS close 1008, e.g. after an app
   * restart killed the sidecar). The shell behind it is brand new: no TUI is
   * running, so the mount MUST NOT take the paths that exist to make a live
   * TUI redraw — the clear-screen on socket open, the mouse/focus mode
   * rehydrate, or the forced SIGWINCH toggle. Clearing the screen here would
   * wipe the scrollback we just restored, which is the "flashes history then
   * goes blank" report.
   *
   * Consumed once by the next mount, which clears it.
   */
  recreated?: boolean
}

function titleNum(title: string) {
  const m = title.match(/^Terminal (\d+)$/)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n
}

function nextNum(all: LocalPTY[]) {
  const nums = new Set(
    all.flatMap((pty) => {
      const direct = Number.isFinite(pty.titleNumber) && pty.titleNumber > 0 ? pty.titleNumber : undefined
      if (direct !== undefined) return [direct]
      const parsed = titleNum(pty.title)
      if (parsed === undefined) return []
      return [parsed]
    }),
  )
  return Array.from({ length: nums.size + 1 }, (_, i) => i + 1).find((n) => !nums.has(n)) ?? 1
}

export function mergeCreatedTerminal(all: LocalPTY[], info: { id: string; title?: string; cwd?: string }) {
  const existing = all.find((pty) => pty.id === info.id)
  if (existing) return all
  const parsed = info.title ? titleNum(info.title) : undefined
  const titleNumber = parsed ?? nextNum(all)
  const title = info.title ?? `Terminal ${titleNumber}`
  return [...all, { id: info.id, title, titleNumber, cwd: info.cwd }]
}
