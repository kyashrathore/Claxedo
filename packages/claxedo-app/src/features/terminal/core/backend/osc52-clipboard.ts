import { Base64, BrowserClipboardProvider, type IClipboardProvider } from "@xterm/addon-clipboard"
import type { IDisposable, Terminal as XTerm } from "@xterm/xterm"

type Osc52Terminal = Pick<XTerm, "input" | "parser">

/**
 * Handles OSC 52 without returning a Promise to xterm's parser.
 *
 * The stock ClipboardAddon returns navigator.clipboard's Promise from its
 * parser handler. While that Promise is pending, xterm cannot safely resize:
 * resize() synchronously flushes the write buffer and permanently fails the
 * paused parser. Clipboard I/O does not need to hold parsing, so acknowledge
 * the sequence immediately and complete the browser operation out of band.
 */
export function installOsc52ClipboardHandler(
  terminal: Osc52Terminal,
  clipboard: IClipboardProvider = new BrowserClipboardProvider(),
): IDisposable {
  const base64 = new Base64()
  let active = true

  const registration = terminal.parser.registerOscHandler(52, (data) => {
    const [selection, payload] = data.split(";")
    if (payload === undefined) return true
    if (payload === "?") {
      try {
        void Promise.resolve(clipboard.readText(selection))
          .then((text) => {
          if (!active) return
          terminal.input(`\x1b]52;${selection};${base64.encodeText(text)}\x07`, false)
          })
          .catch(() => {})
      } catch {}
      return true
    }

    let text = ""
    try {
      text = base64.decodeText(payload)
    } catch {}
    try {
      void Promise.resolve(clipboard.writeText(selection, text)).catch(() => {})
    } catch {}
    return true
  })

  return {
    dispose() {
      active = false
      registration.dispose()
    },
  }
}
