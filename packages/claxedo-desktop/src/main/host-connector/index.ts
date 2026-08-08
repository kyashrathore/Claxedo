/**
 * Assembling the Host Connector for a real Electron process.
 *
 * Same shape as `account/index.ts`: everything here is wiring, and every
 * decision lives in the module it belongs to — the protocol in
 * `@claxedo/host-connector/connector`, the key and the id in
 * `machine-identity.ts`, the closed set of authenticated calls in
 * `account/hosted-operations.ts`.
 *
 * Three things it is careful about:
 *
 *   - **It never sees the account credential.** The connector signs with the
 *     machine key; the account bearer is attached inside the account service,
 *     which is why `run` — a named operation, not a URL — is the only thing
 *     passed in. A connector that held the account token would be a background
 *     child process holding the user's session, and the headless
 *     `@claxedo/host-connector` deployment has no account at all.
 *   - **It refuses rather than degrades.** No secure store means no identity
 *     means no Remote Access; local work is unaffected, which is the whole
 *     point of the desktop.
 *   - **It takes electron as INPUT.** `safeStorage` and the userData path
 *     arrive as arguments, so this file is directly testable in a plain
 *     process — the same split `ipc-caller-guard.ts` and `navigation-guard.ts`
 *     use, and the reason `account/index.ts` has no test beside it.
 *
 * It registers NO IPC itself. `ipc.ts` beside it owns the four named operations
 * the renderer may ask for and `status-channel.ts` owns the push back; keeping
 * assembly, the inbound surface and the outbound one in three files is what
 * makes "what can the renderer reach?" answerable by reading one of them.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHostConnector, type ConnectorState, type ConnectorTransport } from "@claxedo/host-connector/connector"
import type { SafeStorageApi } from "../account/credential-store"
import { loadOrCreateMachineIdentity, type MachineIdentityFile } from "./machine-identity"

/**
 * The account service's `run`, and nothing else.
 *
 * Typed by NAME rather than as `HostedOperationName` because that union lives
 * in `account/`, which this module deliberately does not depend on: the
 * connector asks for an operation and the account decides what one is. A name
 * nobody wrote down fails loudly at `resolveHostedOperation` rather than
 * silently taking some default — there is no default.
 */
export type AccountOperationRunner = (name: string, input?: Record<string, unknown>) => Promise<unknown>

/**
 * The three operations the enrollment handshake needs.
 *
 * All three routes are signed-only (`routes/hosted/host-enrollment.ts`), so all
 * three must travel through the account service — the connector has no bearer
 * of its own.
 *
 * All three are rows in the reviewed table (`account/hosted-operations.ts`), so
 * the handshake performs three named operations and never composes a request.
 * Adding a fourth means adding a matrix row and a table entry first; `start()`
 * would otherwise stop with an error naming the missing operation, which is the
 * correct outcome and the reason nothing here reaches for a generic path.
 */
export const HOST_ENROLLMENT_OPERATIONS = {
  createRequest: "host.enrollmentNonce",
  enroll: "host.enrollCurrentMachine",
  heartbeat: "host.enrollmentHeartbeat",
} as const

/**
 * How often to prove the machine is still here.
 *
 * The authority's default enrollment TTL is 60s (`DEFAULT_TTL_MS`), so this is
 * a third of it: one dropped beat — a wifi blip, a suspended laptop mid-request
 * — must not expire an enrollment the user still wants.
 */
const HEARTBEAT_INTERVAL_MS = 20_000

export type HostConnectorStatus =
  | { status: "not-started" }
  | { status: "unavailable"; reason: "no-secure-storage"; detail: string }
  | ConnectorState

/** A field that must be a string, or a decode failure that says which. */
function requireString(value: unknown, field: string, operation: string): string {
  if (typeof value !== "string" || !value) throw new Error(`operation "${operation}" returned no ${field}`)
  return value
}

function requireNumber(value: unknown, field: string, operation: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`operation "${operation}" returned no ${field}`)
  }
  return value
}

/**
 * The connector's transport, expressed as named account operations.
 *
 * Decoded here rather than cast. `run` returns `unknown` — it is the other side
 * of an IPC-shaped boundary — and a cast would turn a server that changed shape
 * into a connector signing `undefined` and blaming the key.
 */
export function accountConnectorTransport(run: AccountOperationRunner): ConnectorTransport {
  return {
    createRequest: async ({ hostId }) => {
      const name = HOST_ENROLLMENT_OPERATIONS.createRequest
      const payload = (await run(name, { hostId })) as Record<string, unknown> | undefined
      return {
        request_id: requireString(payload?.["request_id"], "request_id", name),
        nonce: requireString(payload?.["nonce"], "nonce", name),
        expires_at: requireNumber(payload?.["expires_at"], "expires_at", name),
      }
    },

    enroll: async (input) => {
      const name = HOST_ENROLLMENT_OPERATIONS.enroll
      const payload = (await run(name, { ...input })) as { enrollment?: Record<string, unknown> } | undefined
      // The route wraps its result: `return { enrollment }`. Reading the
      // envelope's fields directly would silently produce an enrollment with no
      // id and an expiry of NaN.
      const enrollment = payload?.enrollment
      return {
        enrollment_id: requireString(enrollment?.["enrollment_id"], "enrollment_id", name),
        host_id: requireString(enrollment?.["host_id"], "host_id", name),
        expires_at: requireNumber(enrollment?.["expires_at"], "expires_at", name),
      }
    },

    heartbeat: async (input) => {
      const name = HOST_ENROLLMENT_OPERATIONS.heartbeat
      const payload = (await run(name, { ...input })) as Record<string, unknown> | undefined
      return { expires_at: requireNumber(payload?.["expires_at"], "expires_at", name) }
    },
  }
}

/** The identity record, in Electron's per-app userData directory. */
export function machineIdentityFile(userDataDir: string): MachineIdentityFile {
  const path = join(userDataDir, "host-machine-identity.json")
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        // Absent is the normal state before the first enrollment.
        return undefined
      }
    },
    // 0600, matching the account credential: the secret is inside the OS store,
    // but the record still names the backend, and no other user needs it.
    write: (contents) => {
      mkdirSync(userDataDir, { recursive: true })
      writeFileSync(path, contents, { mode: 0o600 })
    },
    clear: () => rmSync(path, { force: true }),
  }
}

/**
 * What this machine is called in the account's device list.
 *
 * A platform word and nothing more. The obvious label is `os.hostname()`, and
 * it is the wrong one for the reason `machine-identity.ts` gives about the host
 * id: a hostname is the laptop's identity on its own network, it is routinely
 * the owner's name, and sending it to the control plane hands that over for no
 * benefit the user asked for. "macOS" tells a person which row is which — which
 * is the whole job of a label — and tells an observer nothing.
 */
export function machineDisplayName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macOS"
  if (platform === "win32") return "Windows"
  if (platform === "linux") return "Linux"
  return "This machine"
}

/** `setInterval`, shaped as the connector's cancellable timer. */
export function nodeInterval() {
  return (fn: () => void, ms: number) => {
    const handle = setInterval(fn, ms)
    // Unref'd: a heartbeat loop must not keep the process alive after quit.
    handle.unref?.()
    return { cancel: () => clearInterval(handle) }
  }
}

export type HostConnectorSetup = {
  status: () => HostConnectorStatus
  start: () => Promise<HostConnectorStatus>
  /** Stop beating. The identity survives, so a later `start` re-enrols it. */
  stop: () => void
  /**
   * Stop beating and destroy this machine's identity.
   *
   * The difference from `stop` is what happens NEXT. Both let the enrollment
   * lapse when its TTL runs out — the control plane forgets a machine that
   * stops proving it is there — but a paused machine can come back as itself,
   * and a revoked one cannot: its private key is gone, so nothing can ever sign
   * as that host id again. A later `start` mints a fresh identity and the
   * control plane sees an honest new machine, which is the same rule
   * `machine-identity.ts` applies to a rotated key.
   */
  revoke: () => void
}

/**
 * Build the Host Connector for this machine.
 *
 * Constructed but NOT started: an unsigned launch must not enroll anything, and
 * the caller starts it only for a linked profile once local-server is healthy.
 */
export function setupHostConnector(input: {
  run: AccountOperationRunner
  safeStorage: SafeStorageApi
  userDataDir: string
  platform?: NodeJS.Platform
  displayName?: string
  heartbeatIntervalMs?: number
  setInterval?: (fn: () => void, ms: number) => { cancel: () => void }
  onError?: (stage: string, error: unknown) => void
  /** Called on every transition. See `settle`. */
  onStatusChange?: (status: HostConnectorStatus) => void
}): HostConnectorSetup {
  let status: HostConnectorStatus = { status: "not-started" }
  let connector: ReturnType<typeof createHostConnector> | undefined

  /**
   * Announce a transition.
   *
   * The Remote Access panel shows state the user did not cause — an expiry, a
   * rejected beat, a revocation — so it cannot be a pull. Every assignment to
   * `status` goes through here rather than to the variable, which is what stops
   * a future branch from changing state silently.
   */
  const settle = (next: HostConnectorStatus) => {
    status = next
    input.onStatusChange?.(next)
    return next
  }

  const live = () => connector !== undefined && connector.state().status !== "stopped"

  return {
    status: () => (connector ? connector.state() : status),

    async start() {
      // Idempotent while a connector is running. A second start would mint a
      // second machine identity's worth of enrollment traffic and leave two
      // heartbeat timers beating for one machine, of which only one can be
      // cancelled by `stop()`.
      if (live()) return connector!.state()

      const identity = await loadOrCreateMachineIdentity({
        safeStorage: input.safeStorage,
        file: machineIdentityFile(input.userDataDir),
        platform: input.platform ?? process.platform,
        ...(input.onError ? { onRejected: (reason) => input.onError?.("machine-identity", reason) } : {}),
      })
      if (!identity.ok) {
        input.onError?.("machine-identity", identity.detail)
        return settle({ status: "unavailable", reason: identity.reason, detail: identity.detail })
      }

      connector = createHostConnector({
        hostId: identity.identity.hostId,
        keys: identity.identity.keys,
        transport: accountConnectorTransport(input.run),
        heartbeatIntervalMs: input.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
        setInterval: input.setInterval ?? nodeInterval(),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.onError ? { onError: (stage, error) => input.onError?.(stage, error) } : {}),
      })
      try {
        settle(await connector.start())
      } catch (error) {
        // Kept after the connector's own `start()` was fixed to catch the nonce
        // request, not before it. That fix removed the known escape; this
        // catches an unknown one, and in Electron main the cost of missing it
        // is an unhandled rejection during startup.
        //
        // The connector is DISCARDED rather than kept: its internal state is
        // still `idle`, and a retained one would make `start()` believe a live
        // connector already exists and never retry.
        input.onError?.("enroll", error)
        connector = undefined
        settle({ status: "stopped", reason: "error", detail: String(error) })
      }
      return status
    },

    stop() {
      // Closing rather than dropping the reference: the heartbeat timer is the
      // thing that must actually stop, and a garbage-collected connector still
      // beats.
      connector?.close()
      // Through `settle`, not a bare assignment: pausing is a transition the
      // panel must see. Before this, a pause left the renderer showing a
      // published machine until something else happened to push.
      if (connector) settle(connector.state())
    },

    revoke() {
      connector?.close()
      // The file, not just the process. The record is the only copy of the
      // private key — `machine-identity.ts` keeps it inside the OS secure
      // store's ciphertext and nowhere else — so removing it is what makes the
      // revocation outlive this launch.
      machineIdentityFile(input.userDataDir).clear()
      // Dropped, so a later `start` takes the mint path rather than believing a
      // live connector already exists. Its key is gone; keeping the object
      // would keep a connector that can only fail.
      connector = undefined
      settle({ status: "stopped", reason: "revoked", detail: "remote access revoked on this machine" })
    },
  }
}
