import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { GATE_EXIT, readCreationIdentity, type GatePayload } from "./launch-gate"

type Activation = { outcome: "activate" } | { outcome: "channel-lost" } | { outcome: "deadline" } | { outcome: "nonce-mismatch" }

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const send = process.send?.bind(process)
if (!send) process.exit(GATE_EXIT.noParentChannel)

const payload = JSON.parse(argument("--payload") ?? "null") as GatePayload | null
const activationDeadlineMs = Number(argument("--activation-deadline-ms") ?? "2000")
if (!payload) throw new Error("Launch gate started without a payload")

const identity = await readCreationIdentity(process.pid)
if (!identity) process.exit(GATE_EXIT.identityUnavailable)

const gateNonce = randomUUID()
send({ type: "identity", identity, gateNonce })

const activation = await waitForActivation()
if (activation.outcome === "channel-lost") process.exit(GATE_EXIT.channelLostBeforeActivation)
if (activation.outcome === "deadline") process.exit(GATE_EXIT.activationDeadline)
if (activation.outcome === "nonce-mismatch") process.exit(GATE_EXIT.nonceMismatch)

// Once activation is authorized the parent's durable record already exists, so
// losing the channel while acknowledging must not cancel the user's work.
try { send({ type: "activated", gateNonce }) } catch { /* the parent is gone; the payload still runs */ }

const child = spawn(payload.command, payload.args, { stdio: "ignore" })
const code = await new Promise<number>((resolve) => {
  child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 0)))
  child.on("error", () => resolve(GATE_EXIT.identityUnavailable))
})
process.exit(code)

function waitForActivation() {
  return new Promise<Activation>((resolve) => {
    const timer = setTimeout(() => finish({ outcome: "deadline" }), activationDeadlineMs)
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null) return
      const frame = message as { type?: unknown; gateNonce?: unknown }
      if (frame.type !== "activate") return
      finish(frame.gateNonce === gateNonce ? { outcome: "activate" } : { outcome: "nonce-mismatch" })
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
