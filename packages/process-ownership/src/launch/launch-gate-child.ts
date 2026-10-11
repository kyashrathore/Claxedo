import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import net from "node:net"
import { isRecord } from "@claxedo/helpers/guards"
import { GATE_EXIT, type GatePayload } from "./launch-gate"
import { launchErrorText, readCreationIdentity, releaseWindowsProcessTable, type CreationIdentity } from "./identity"

type Activation =
  | { outcome: "activate"; payload: GatePayload }
  | { outcome: "channel-lost" }
  | { outcome: "deadline" }
  | { outcome: "nonce-mismatch" }

/** The private channel to the host: Node's IPC channel, or the named pipe a terminal's gate is given. */
type GateChannel = {
  send(frame: Record<string, unknown>): void
  onMessage(listener: (frame: unknown) => void): () => void
  onClose(listener: () => void): () => void
  release(): void
}

/**
 * The gate program. It is spawned by path and never imported for its effects,
 * so importing it — which this package's own export checker does — must not
 * start a gate or exit the importer.
 */
export async function runLaunchGateChild(): Promise<never> {
  const activationDeadlineMs = Number(argument("--activation-deadline-ms") ?? "10000")
  const pipe = argument("--activation-pipe")
  const channel = pipe ? await pipeChannel(pipe) : ipcChannel()
  if (!channel) process.exit(GATE_EXIT.noParentChannel)

  // Minted here and delivered only over the private channel, so activation
  // proves the sender received that message. An environment variable or an
  // argv token carries no nonce and therefore authorizes nothing.
  const gateNonce = randomUUID()
  if (pipe) {
    // A terminal's host reads this gate's identity itself, from a process
    // table reader that is already running.
    channel.send({ type: "hello", pid: process.pid, gateNonce })
  } else {
    channel.send({ type: "identity", identity: await ownIdentity(), gateNonce })
  }

  const activation = await waitForActivation(channel, gateNonce, activationDeadlineMs)
  if (activation.outcome === "channel-lost") process.exit(GATE_EXIT.channelLostBeforeActivation)
  if (activation.outcome === "deadline") process.exit(GATE_EXIT.activationDeadline)
  if (activation.outcome === "nonce-mismatch") process.exit(GATE_EXIT.nonceMismatch)

  // This process leads the group the host recorded, so it must outlive its own
  // payload: an early exit here would make the recorded leader read as gone
  // while the payload is still running. A terminal's console delivers Ctrl+C
  // and Ctrl+Break to every process attached to it, this one included.
  const ignored: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"]
  if (process.platform === "win32") ignored.push("SIGBREAK")
  for (const signal of ignored) process.on(signal, () => {})

  const child = spawn(activation.payload.command, activation.payload.args, {
    env: activation.payload.env,
    stdio: ["inherit", "inherit", "inherit"],
  })

  const trySend = (frame: Record<string, unknown>) => {
    try {
      channel.send(frame)
    } catch {
      // The parent is gone; the payload still runs and its record already exists.
    }
  }

  const started = await new Promise<{ ok: true } | { ok: false; error: Error }>((resolve) => {
    child.once("spawn", () => resolve({ ok: true }))
    child.once("error", (error) => resolve({ ok: false, error }))
  })
  if (!started.ok) {
    trySend({ type: "failed", gateNonce, message: started.error.message })
    process.exit(GATE_EXIT.payloadSpawnFailed)
  }
  // Past activation the host's record already exists, so losing the channel
  // while acknowledging must not cancel the user's work.
  trySend({ type: "activated", gateNonce, pid: child.pid })
  if (pipe) channel.release()

  const code = await new Promise<number>((resolve) => {
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 0)))
    child.on("error", () => resolve(GATE_EXIT.payloadSpawnFailed))
  })
  process.exit(code)
}

async function ownIdentity(): Promise<CreationIdentity> {
  let identity: CreationIdentity | undefined
  try {
    identity = await readCreationIdentity(process.pid)
  } catch (error) {
    // The host reads this stream until the identity frame arrives, so the
    // reason travels as one line rather than as an uncaught-exception dump.
    process.stderr.write(`${launchErrorText(error)}\n`)
  }
  releaseWindowsProcessTable()
  if (!identity) process.exit(GATE_EXIT.identityUnavailable)
  return identity
}

function ipcChannel(): GateChannel | undefined {
  const send = process.send?.bind(process)
  if (!send) return undefined
  return {
    send: (frame) => { send(frame) },
    onMessage: (listener) => {
      process.on("message", listener)
      return () => { process.off("message", listener) }
    },
    onClose: (listener) => {
      process.on("disconnect", listener)
      return () => { process.off("disconnect", listener) }
    },
    release: () => {},
  }
}

/** One JSON frame per line, in both directions. */
function pipeChannel(pipe: string): Promise<GateChannel | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(pipe)
    socket.once("error", () => resolve(undefined))
    socket.once("connect", () => {
      const listeners = new Set<(frame: unknown) => void>()
      let partial = ""
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
          for (const listener of listeners) listener(frame)
        }
      })
      resolve({
        send: (frame) => { socket.write(`${JSON.stringify(frame)}\n`) },
        onMessage: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        onClose: (listener) => {
          socket.on("close", listener)
          return () => { socket.off("close", listener) }
        },
        release: () => { socket.end() },
      })
    })
  })
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function gatePayload(value: unknown): GatePayload | undefined {
  if (!isRecord(value)) return undefined
  const { command, args, env } = value
  if (typeof command !== "string" || !Array.isArray(args) || !isRecord(env)) return undefined
  const parts: string[] = []
  for (const arg of args) {
    if (typeof arg !== "string") return undefined
    parts.push(arg)
  }
  const variables: Record<string, string> = {}
  for (const [name, variable] of Object.entries(env)) {
    if (typeof variable !== "string") return undefined
    variables[name] = variable
  }
  return { command, args: parts, env: variables }
}

function waitForActivation(channel: GateChannel, gateNonce: string, activationDeadlineMs: number) {
  return new Promise<Activation>((resolve) => {
    const timer = setTimeout(() => finish({ outcome: "deadline" }), activationDeadlineMs)
    const offMessage = channel.onMessage((frame) => {
      if (typeof frame !== "object" || frame === null) return
      const message = frame as { type?: unknown; gateNonce?: unknown; payload?: unknown }
      if (message.type !== "activate") return
      if (message.gateNonce !== gateNonce) return finish({ outcome: "nonce-mismatch" })
      const payload = gatePayload(message.payload)
      // An activate frame without a well-formed payload authorizes nothing to
      // run, so this gate keeps waiting and the deadline reports that none arrived.
      if (!payload) return
      finish({ outcome: "activate", payload })
    })
    const offClose = channel.onClose(() => finish({ outcome: "channel-lost" }))
    const finish = (result: Activation) => {
      clearTimeout(timer)
      offMessage()
      offClose()
      resolve(result)
    }
  })
}

// Both Bun and Node report this false for an import and true for the file they
// were started with, including the bundled `.mjs` the desktop app spawns.
if (import.meta.main) await runLaunchGateChild()
