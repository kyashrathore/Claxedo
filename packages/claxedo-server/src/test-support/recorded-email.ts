import { readFile } from "node:fs/promises"
import type { Readable } from "node:stream"

/** `actionUrl` is the link `cloudflareAuthEmailSender` puts on the text body's last line. */
export type RecordedEmail = { to: string; from: string; subject: string; text?: string; html?: string; actionUrl?: string }

const MESSAGE_MARKER = "send_email binding called with MessageBuilder:"
const ANSI = /\x1b\[[0-9;]*m/g

function header(block: string, name: string) {
  return new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1]?.trim()
}

/**
 * The messages a Worker sent through Miniflare's simulated `send_email`
 * binding. Miniflare does not return them: workerd's stdout carries each
 * message's headers and the temp files it wrote the text and HTML bodies to,
 * so the outbox is wired in as the instance's `handleRuntimeStdio` and reads
 * that output back. `forward` keeps the runtime's output visible.
 */
export function recordedEmailOutbox(forward?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }) {
  let output = ""
  const messages = async () => {
    const blocks = output.replace(ANSI, "").split(MESSAGE_MARKER).slice(1)
    return await Promise.all(blocks.map(async (block): Promise<RecordedEmail> => {
      const textFile = header(block, "Text")
      const htmlFile = header(block, "HTML")
      const text = textFile ? await readFile(textFile, "utf8") : undefined
      const lastLine = text?.trim().split("\n").at(-1)
      return {
        to: header(block, "To") ?? "",
        from: header(block, "From") ?? "",
        subject: header(block, "Subject") ?? "",
        ...(text !== undefined ? { text } : {}),
        ...(htmlFile ? { html: await readFile(htmlFile, "utf8") } : {}),
        ...(lastLine && URL.canParse(lastLine) ? { actionUrl: lastLine } : {}),
      }
    }))
  }
  return {
    handleRuntimeStdio: (stdout: Readable, stderr: Readable) => {
      stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8")
        forward?.stdout.write(chunk)
      })
      if (forward) stderr.pipe(forward.stderr)
      else stderr.resume()
    },
    messages,
    /** The latest recorded message `match` accepts; the log line can trail the binding's answer, so it waits up to `timeoutMs`. */
    async waitFor(match: (email: RecordedEmail) => boolean, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = (await messages()).findLast(match)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`no recorded email matched within ${timeoutMs} ms`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
  }
}
