import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { GATE_EXIT, type GatePayload } from "./launch-gate"
import { readCreationIdentity } from "./identity"

type Activation =
  | { outcome: "activate"; payload: GatePayload }
  | { outcome: "channel-lost" }
  | { outcome: "deadline" }
  | { outcome: "nonce-mismatch" }

/**
 * The gate program. It is spawned by path and never imported for its effects,
 * so importing it — which this package's own export checker does — must not
 * start a gate or exit the importer.
 */
export async function runLaunchGateChild(): Promise<never> {
  const send = process.send?.bind(process)
  if (!send) process.exit(GATE_EXIT.noParentChannel)

  const activationDeadlineMs = Number(argument("--activation-deadline-ms") ?? "10000")

  const identity = await readCreationIdentity(process.pid)
  if (!identity) process.exit(GATE_EXIT.identityUnavailable)

  // Minted here and delivered only over the private channel, so activation
  // proves the sender received that message. An environment variable or an
  // argv token carries no nonce and therefore authorizes nothing.
  const gateNonce = randomUUID()
  send({ type: "identity", identity, gateNonce })

  const activation = await waitForActivation(gateNonce, activationDeadlineMs)
  if (activation.outcome === "channel-lost") process.exit(GATE_EXIT.channelLostBeforeActivation)
  if (activation.outcome === "deadline") process.exit(GATE_EXIT.activationDeadline)
  if (activation.outcome === "nonce-mismatch") process.exit(GATE_EXIT.nonceMismatch)

  // This process leads the group the host recorded, so it must outlive its own
  // payload: an early exit here would make the recorded leader read as gone
  // while the payload is still running.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {})

  const child = spawn(activation.payload.command, activation.payload.args, {
    stdio: ["inherit", "inherit", "inherit"],
  })

  const trySend = (frame: Record<string, unknown>) => {
    try {
      send(frame)
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

  const code = await new Promise<number>((resolve) => {
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 0)))
    child.on("error", () => resolve(GATE_EXIT.payloadSpawnFailed))
  })
  process.exit(code)
}

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function waitForActivation(gateNonce: string, activationDeadlineMs: number) {
  return new Promise<Activation>((resolve) => {
    const timer = setTimeout(() => finish({ outcome: "deadline" }), activationDeadlineMs)
    const onMessage = (frame: unknown) => {
      if (typeof frame !== "object" || frame === null) return
      const message = frame as { type?: unknown; gateNonce?: unknown; payload?: unknown }
      if (message.type !== "activate") return
      if (message.gateNonce !== gateNonce) return finish({ outcome: "nonce-mismatch" })
      finish({ outcome: "activate", payload: message.payload as GatePayload })
    }
    const onChannelLost = () => finish({ outcome: "channel-lost" })
    const finish = (result: Activation) => {
      clearTimeout(timer)
      process.off("message", onMessage)
      process.off("disconnect", onChannelLost)
      resolve(result)
    }
    process.on("message", onMessage)
    process.on("disconnect", onChannelLost)
  })
}

// Both Bun and Node report this false for an import and true for the file they
// were started with, including the bundled `.mjs` the desktop app spawns.
if (import.meta.main) await runLaunchGateChild()
