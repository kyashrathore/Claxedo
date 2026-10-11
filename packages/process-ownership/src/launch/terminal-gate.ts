import { randomUUID } from "node:crypto"
import net from "node:net"
import { stringRecord } from "@claxedo/helpers"
import { isRecord } from "@claxedo/helpers/guards"
import { harnessSpawnEnv } from "../spawn-env"
import type { CreationIdentity } from "./identity"
import { resolveLaunchGateChild, type GatePayload } from "./launch-gate"
import { containInWindowsJob, warmWindowsJobs } from "./windows-job"

/**
 * A Windows terminal's launch gate. A PTY library starts the gate attached to
 * its pseudoconsole in place of the shell, and the gate starts the shell only
 * once this host has contained it, so nothing the shell ever starts is outside
 * the gate's job. `forkpty` cannot carry Node's IPC channel, so the activation
 * travels over a named pipe this host listens on.
 *
 * Gate and job end together, and the gate exits with its payload's exit code,
 * so the gate stands for the shell in every place the PTY library reports one.
 */
export type TerminalGate = {
  file: string
  args: string[]
  /** The gate's own environment; the payload's travels with the activation. */
  env: Record<string, string>
  /**
   * Contains the gate the PTY started, which `identity` describes, then lets
   * it start `payload`. `exited` is a gate that ended before it was contained.
   */
  activate(identity: CreationIdentity, payload: GatePayload): Promise<"activated" | "exited">
  /** Ends the channel, and with it a gate that was never activated. */
  close(): void
}

/**
 * Admission reads the gate's identity and contains it, and a runtime's first
 * read and first containment each start PowerShell, so the gate waits for
 * longer than a harness gate does.
 */
const TERMINAL_ACTIVATION_DEADLINE_MS = 60_000

export async function openTerminalGate(): Promise<TerminalGate> {
  const entry = resolveLaunchGateChild()
  warmWindowsJobs()
  const pipe = `\\\\.\\pipe\\claxedo-terminal-gate-${randomUUID()}`
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(pipe, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const frames = acceptOne(server)
  const close = () => {
    server.close()
    frames.close()
  }
  const admit = async (identity: CreationIdentity, payload: GatePayload) => {
    const channel = await frames.connected
    const hello = await channel.next("hello")
    if (hello.pid !== identity.pid) throw new Error(`the terminal gate reported pid ${String(hello.pid)}, but the terminal started ${identity.pid}`)
    if ((await containInWindowsJob(identity)) === "exited") return "exited" as const
    channel.send({ type: "activate", gateNonce: hello.gateNonce, payload })
    const answer = await channel.next("activated", "failed")
    if (answer.type === "failed") throw new Error(`the terminal gate could not start ${payload.command}: ${String(answer.message)}`)
    return "activated" as const
  }
  return {
    file: process.execPath,
    args: [...entry.runner, entry.file, "--activation-pipe", pipe, "--activation-deadline-ms", String(TERMINAL_ACTIVATION_DEADLINE_MS)],
    env: stringRecord(harnessSpawnEnv(process.env)),
    activate: async (identity, payload) => {
      // Referenced: Bun on Windows never fires an unreferenced timer that is
      // the loop's only work.
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          close()
          reject(new Error(`the terminal gate was not admitted within ${TERMINAL_ACTIVATION_DEADLINE_MS}ms`))
        }, TERMINAL_ACTIVATION_DEADLINE_MS)
      })
      try {
        return await Promise.race([admit(identity, payload), expired])
      } finally {
        clearTimeout(timer)
      }
    },
    close,
  }
}

type Frame = Record<string, unknown>

type FrameChannel = {
  next(...types: string[]): Promise<Frame>
  send(frame: Record<string, unknown>): void
}

/**
 * The first connection is the gate's; the server stops listening as soon as it
 * arrives, so nothing else can reach this gate's activation.
 */
function acceptOne(server: net.Server) {
  let socket: net.Socket | undefined
  let closed = false
  const connected = new Promise<FrameChannel>((resolve, reject) => {
    server.once("connection", (accepted) => {
      server.close()
      if (closed) {
        accepted.destroy()
        return
      }
      socket = accepted
      resolve(frameChannel(accepted))
    })
    server.once("close", () => { if (!socket) reject(new Error("the terminal gate never connected")) })
  })
  void connected.catch(() => {})
  return {
    connected,
    close: () => {
      closed = true
      socket?.destroy()
    },
  }
}

function frameChannel(socket: net.Socket): FrameChannel {
  const queued: Frame[] = []
  let waiting: { types: string[]; resolve(frame: Frame): void; reject(error: Error): void } | undefined
  let ended: Error | undefined
  let partial = ""
  const deliver = () => {
    if (!waiting) return
    const { types } = waiting
    const index = queued.findIndex((frame) => typeof frame.type === "string" && types.includes(frame.type))
    const frame = index >= 0 ? queued.splice(index, 1)[0] : undefined
    if (frame) {
      const current = waiting
      waiting = undefined
      current.resolve(frame)
    } else if (ended) {
      const current = waiting
      waiting = undefined
      current.reject(ended)
    }
  }
  socket.on("data", (chunk: Buffer) => {
    partial += chunk.toString()
    for (let end = partial.indexOf("\n"); end >= 0; end = partial.indexOf("\n")) {
      const line = partial.slice(0, end)
      partial = partial.slice(end + 1)
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (isRecord(frame)) queued.push(frame)
    }
    deliver()
  })
  socket.on("error", () => {})
  socket.on("close", () => {
    ended = new Error("the terminal gate closed its channel")
    deliver()
  })
  return {
    next: (...types) => new Promise((resolve, reject) => {
      waiting = { types, resolve, reject }
      deliver()
    }),
    send: (frame) => { socket.write(`${JSON.stringify(frame)}\n`) },
  }
}
