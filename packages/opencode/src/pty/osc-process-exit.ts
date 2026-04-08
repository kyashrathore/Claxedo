/**
 * OSC process-exit parser.
 *
 * Parses terminal escape sequences of the form:
 *   ESC ] 777 ; process-exit ; <exit_code> BEL
 *   ESC ] 777 ; process-exit ; <exit_code> ESC \
 *
 * Returns the exit code (if found) and a partial buffer for split-chunk reassembly.
 */
export function oscProcessExit(buf: string, chunk: string): { exitCode?: number; buf: string } {
  const esc = "\x1b"
  const bel = "\x07"
  const prefix = `${esc}]777;process-exit;`
  const max = 128

  const data = buf + chunk

  let pos = 0
  let exitCode: number | undefined
  for (;;) {
    const start = data.indexOf(prefix, pos)
    if (start === -1) break

    const from = start + prefix.length
    const belEnd = data.indexOf(bel, from)
    const st = `${esc}\\`
    const stEnd = data.indexOf(st, from)

    const end = (() => {
      if (belEnd === -1) return stEnd
      if (stEnd === -1) return belEnd
      return Math.min(belEnd, stEnd)
    })()

    if (end === -1) {
      const tail = data.slice(start)
      return {
        exitCode,
        buf: tail.length <= max ? tail : "",
      }
    }

    const body = data.slice(from, end)
    const code = parseInt(body, 10)
    if (Number.isFinite(code) && code >= 0) {
      exitCode = code
    }

    pos = end + (end === stEnd ? st.length : 1)
  }

  const last = data.lastIndexOf(esc)
  if (last === -1) return { exitCode, buf: "" }

  const tail = data.slice(last)
  if (!prefix.startsWith(tail)) return { exitCode, buf: "" }
  return { exitCode, buf: tail.length <= max ? tail : "" }
}
