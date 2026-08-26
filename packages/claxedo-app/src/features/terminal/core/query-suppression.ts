export function createQuerySuppressor(input?: { maxTail?: number }) {
  const maxTail = input?.maxTail ?? 4096
  let carry = ""
  const cprPattern = /^\x1b\[\??[0-9]{1,4}(?:;[0-9]{1,4}){1,2}R$/
  const modeReportPattern = /^\x1b\[[?0-9;]*\$y$/
  const daReplyPattern = /^\x1b\[(?:\?|>)[0-9;]+c$/
  const dcsReportPattern = /^\x1bP[01][+$]r[\s\S]*(?:\x1b\\|\x07)$/

  return {
    scan(chunk: string) {
      // Terminal output arrives as tens of thousands of PTY writes. Rebuilding
      // each chunk one character at a time cost one intermediate string per byte
      // of output — ~197M appends for the 210 MiB canonical stream — which is
      // pure transient garbage the renderer's heap has to absorb mid-stream.
      // Two allocation guards, both output-identical:
      //   1. A chunk with no ESC and no pending carry needs no rewriting at all,
      //      so return it unchanged.
      //   2. Otherwise copy each literal run as one slice instead of per char.
      // Same suppression set, same carry semantics, byte-identical output.
      if (carry === "" && chunk.indexOf("\u001b") === -1) return chunk

      const data = carry === "" ? chunk : carry + chunk
      let out = ""
      let i = 0
      carry = ""

      while (i < data.length) {
        const esc = data.indexOf("\u001b", i)
        if (esc === -1) {
          out += data.slice(i)
          break
        }
        if (esc > i) out += data.slice(i, esc)
        i = esc

        if (i + 1 >= data.length) {
          carry = data.slice(i)
          break
        }

        const next = data[i + 1]
        if (next !== "[") {
          if (next === "P" || next === "]") {
            // DCS (ESC P) or OSC (ESC ]) sequence terminated by ST (ESC \) or BEL.
            // DCS query replies are suppressed; OSC sequences are passed through.
            // Both must be handled atomically so the ST terminator is never split
            // across carry boundaries — if split, xterm.js never fires its OSC/DCS
            // handlers until the next chunk arrives (causing the 2-second codex delay).
            let j = i + 2
            let term = -1
            while (j < data.length) {
              const code = data.charCodeAt(j)
              if (code === 0x07) {
                term = j
                break
              }
              if (code === 0x1b && j + 1 < data.length && data.charCodeAt(j + 1) === 0x5c) {
                term = j + 1
                break
              }
              j += 1
            }
            if (term === -1) {
              carry = data.slice(i)
              break
            }
            const seq = data.slice(i, term + 1)
            if (next === "P" && dcsReportPattern.test(seq)) {
              // suppress DCS report replies
            } else {
              out += seq
            }
            i = term + 1
            continue
          }
          out += "\u001b"
          i += 1
          continue
        }

        let j = i + 2
        while (j < data.length) {
          const code = data.charCodeAt(j)
          if (code >= 0x40 && code <= 0x7e) break
          j += 1
        }

        if (j >= data.length) {
          carry = data.slice(i)
          break
        }

        const seq = data.slice(i, j + 1)
        const suppress =
          cprPattern.test(seq) ||
          modeReportPattern.test(seq) ||
          daReplyPattern.test(seq) ||
          seq === "\x1b[I" ||
          seq === "\x1b[O"
        if (!suppress) out += seq
        i = j + 1
      }

      if (carry.length > maxTail) {
        out += carry
        carry = ""
      }
      return out
    },
    tail() {
      return carry
    },
  }
}
