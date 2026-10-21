import assert from "node:assert/strict"

const ROOT_REFUSAL = "cannot be used with root/sudo privileges"

/**
 * The agent CLIs a cloud workspace terminal starts with permission checks
 * skipped, as the image's user (root). Each expectation is what the pinned CLI
 * prints once it is past its launch checks with no account signed in, which is
 * the state of every image build.
 */
const TERMINAL_AGENTS = [
  { name: "Claude Code", command: "claude -p --dangerously-skip-permissions 'Reply OK'", started: /Not logged in/ },
  { name: "Codex", command: "codex --ask-for-approval never --sandbox danger-full-access", started: /YOLO\s*mode/ },
] as const

function frameText(data: unknown, decoder: TextDecoder) {
  if (typeof data === "string") return data
  if (!(data instanceof ArrayBuffer)) return ""
  const bytes = new Uint8Array(data)
  if (bytes[0] !== 0) return decoder.decode(bytes, { stream: true })
  const screen = field(field(JSON.parse(new TextDecoder().decode(bytes.subarray(1))), "checkpoint"), "screen")
  return typeof screen === "string" ? screen : ""
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

function plain(text: string) {
  return text.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g, "")
}

async function terminalOutputUntil(origin: string, terminalId: string, done: (text: string) => boolean, timeoutMs: number) {
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/wr/pty/${terminalId}/connect?cursor=0`)
  socket.binaryType = "arraybuffer"
  const decoder = new TextDecoder()
  let output = ""
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve(plain(output)), timeoutMs)
      socket.onmessage = (event) => {
        output += frameText(event.data, decoder)
        if (!done(plain(output))) return
        clearTimeout(timer)
        resolve(plain(output))
      }
      socket.onerror = () => { clearTimeout(timer); reject(new Error(`terminal ${terminalId} stream failed`)) }
    })
  } finally {
    socket.close()
  }
}

/** Starts each agent CLI in a terminal of the runtime at `origin`, the way the terminal's agent entries do. */
export async function assertTerminalAgentsStart(origin: string) {
  for (const agent of TERMINAL_AGENTS) {
    const created = await fetch(`${origin}/api/wr/pty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: agent.name, initialCommand: agent.command }),
    })
    const info: unknown = await created.json()
    const id = field(info, "id")
    assert(created.ok && typeof id === "string", `${agent.name} terminal: ${created.status} ${JSON.stringify(info)}`)
    try {
      const output = await terminalOutputUntil(origin, id, (text) => text.includes(ROOT_REFUSAL) || agent.started.test(text), 60_000)
      assert(!output.includes(ROOT_REFUSAL), `${agent.name} refused to run as root in a workspace terminal: ${output.slice(-400)}`)
      assert.match(output, agent.started, `${agent.name} did not start in a workspace terminal: ${output.slice(-400)}`)
    } finally {
      await fetch(`${origin}/api/wr/pty/${id}`, { method: "DELETE" })
    }
  }
}
