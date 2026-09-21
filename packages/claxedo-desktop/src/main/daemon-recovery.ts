/**
 * Recovering a published daemon that stopped answering.
 *
 * This is the one path where HTTP cannot be asked, so every fact has to come
 * from the OS and from the files the daemon left behind. Two rules make that
 * safe, and both are refusals:
 *
 *   - Nothing is signalled until `(pid, group, start second, boot time)` still
 *     answers for the launch the discovery file recorded. A failed health probe
 *     is evidence about a listener, never authority over a pid.
 *   - Nothing is reported as stopped until the leader is verified gone. A
 *     survivor after KILL keeps the machine unresolved and blocks a replacement,
 *     because two daemons over one data directory is worse than none.
 *
 * Every receipt is volatile: the daemon's own store is unreachable by
 * definition here, and this process never edits it.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  DAEMON_OWNERSHIP_SNAPSHOT_FILE,
  DAEMON_OWNERSHIP_SNAPSHOT_STALE_MS,
  DEFAULT_RECOVERY_BUDGETS,
  RecoveryContractError,
  parseRecoveryOutcome,
  parseRecoveryRequest,
  recoveryTargetsMatch,
  type RecoveryError,
  type RecoveryFacts,
  type RecoveryMachineTarget,
  type RecoveryOperation,
  type RecoveryOutcome,
  type RecoveryRequest,
  type RecoveryScopePreview,
} from "@claxedo/agent-runtime-contract"
import {
  retire,
  retirementSettled,
  verifyCreationIdentity,
  type RetirementBudgets,
  type RetirementResult,
} from "@claxedo/agent-sdk-runtime/launch"

import { asRecord, isNonEmptyString } from "../shared/json-read"
import { nodeErrorCode } from "../shared/node-error"
import { CLAXEDO_DAEMON_PROTOCOL, DAEMON_PROTOCOL_HEADER, type ClaxedoDaemonDiscovery } from "./server-daemon-discovery"
import type { DaemonFetch } from "./daemon-request"

/** The redacted inventory the daemon republished. It is a view, never proof of exit. */
export type DaemonOwnershipView = {
  machineId: string
  generation: string
  pid: number
  revision: string
  writtenAt: number
  residencyPins: number
  owners: Array<{ id: string; kind: string; generation: string; state: string; pins: boolean; detail?: string }>
}

/** The shape both the daemon's route and this bridge answer an inspection with. */
export type DaemonRecoveryInspection = {
  machineId: string
  generation: string
  target: RecoveryMachineTarget
  scopeRevision: string
  owners: DaemonOwnershipView["owners"]
  preview: RecoveryScopePreview
  residencyPins: number
  operations: RecoveryOperation[]
  receipt: "durable" | "volatile"
}

export type DaemonRecoveryResult = {
  outcome: RecoveryOutcome
  /**
   * Whether a replacement daemon may be started. False whenever this process
   * could not establish that the old one is gone.
   */
  replacementAllowed: boolean
}

export function claxedoDaemonOwnershipPath(dataRoot: string) {
  return path.join(dataRoot, DAEMON_OWNERSHIP_SNAPSHOT_FILE)
}

export function readDaemonOwnershipView(file: string): DaemonOwnershipView | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT" || error instanceof SyntaxError) return undefined
    throw error
  }
  return isDaemonOwnershipView(parsed) ? parsed : undefined
}

/**
 * What stopping this daemon would interrupt, as far as anything here can know.
 *
 * The snapshot is one process's last published view of itself, so its age is
 * part of the answer and "additional impact is unknown" is stated rather than
 * implied. Authorization therefore always covers the whole verified daemon
 * generation — a recent snapshot does not narrow it.
 */
export function daemonRecoveryPreview(
  discovery: ClaxedoDaemonDiscovery,
  snapshot: DaemonOwnershipView | undefined,
  at: number,
): RecoveryScopePreview {
  if (!snapshot || snapshot.generation !== discovery.generation) {
    return {
      sessions: [],
      resources: [`daemon generation ${discovery.generation} (pid ${discovery.pid})`],
      summary: "no ownership snapshot for this daemon generation; everything it owns is unknown",
    }
  }
  const ageMs = at - snapshot.writtenAt
  const stale = ageMs > DAEMON_OWNERSHIP_SNAPSHOT_STALE_MS
  return {
    sessions: [],
    resources: [
      `daemon generation ${discovery.generation} (pid ${discovery.pid})`,
      ...snapshot.owners.map((owner) => `${owner.id} (${owner.state})`),
    ],
    summary: `${snapshot.owners.length} owners recorded ${Math.round(ageMs / 1000)}s ago${
      stale ? " (stale)" : ""
    }; additional impact is unknown, so this authorizes the entire daemon generation`,
  }
}

/**
 * Verify, authorize, retire, verify again.
 *
 * `authorize` is the main-process decision: it is asked only once identity is
 * established, and a "no" leaves the daemon running and the app in a state that
 * exposes the recovery view. There is no automatic kill on launch.
 */
export async function recoverPublishedDaemon(input: {
  discovery: ClaxedoDaemonDiscovery
  snapshot?: DaemonOwnershipView | undefined
  authorize: (preview: RecoveryScopePreview) => boolean | Promise<boolean>
  budgets?: RetirementBudgets
  now?: () => number
  verify?: typeof verifyCreationIdentity
  retireLaunch?: typeof retire
}): Promise<DaemonRecoveryResult> {
  const now = input.now ?? Date.now
  const verify = input.verify ?? verifyCreationIdentity
  const retireLaunch = input.retireLaunch ?? retire
  const budgets = input.budgets ?? DEFAULT_RECOVERY_BUDGETS
  const target: RecoveryMachineTarget = {
    scope: "machine",
    machineId: "local",
    ownerGeneration: input.discovery.generation,
  }
  const preview = daemonRecoveryPreview(input.discovery, input.snapshot, now())
  const started = now()
  const operation = (
    state: RecoveryOperation["state"],
    facts: RecoveryFacts,
    error?: RecoveryError,
    nextActions: RecoveryOperation["nextActions"] = [],
  ): DaemonRecoveryResult => ({
    outcome: {
      kind: "operation",
      operation: {
        operationId: randomUUID(),
        requestId: `desktop-launch-${input.discovery.generation}`,
        target,
        action: "stop_daemon",
        scopeRevision: input.snapshot?.revision ?? "unverified",
        attempt: 1,
        state,
        phase: error?.stage ?? "kill_verify",
        phaseDeadlineAt: started + budgets.termGraceMs + budgets.killVerifyMs,
        facts,
        ...(error ? { initiatingError: error } : {}),
        cleanupErrors: [],
        nextActions,
        // The daemon's store is unreachable here by definition, and this
        // process never writes into it.
        receipt: "volatile",
        createdAt: started,
        updatedAt: now(),
      },
    },
    replacementAllowed: state === "succeeded",
  })

  const refusal = (code: RecoveryError["code"], message: string, stage: RecoveryError["stage"]) =>
    operation(
      "needs_action",
      unknownFacts(input.discovery.generation, now()),
      { code, origin: "desktop-launcher", target, stage, executionMayContinue: true, message, at: now() },
      [{ action: "inspect", scopePreviewRequired: false, reason: preview.summary }],
    )

  if (!input.discovery.identity) {
    return refusal(
      "ownership_unverified",
      `The daemon published as pid ${input.discovery.pid} recorded no process identity, so nothing here can establish that this pid is still it. `
        + "Stop that process yourself and remove the discovery file, then start the app again.",
      "ack",
    )
  }

  const verdict = await verify(input.discovery.identity)
  if (verdict.state === "unknown") {
    return refusal(
      "ownership_unverified",
      `Whether pid ${input.discovery.pid} is still the recorded daemon could not be established: ${verdict.reason}`,
      "ack",
    )
  }
  if (verdict.state === "identity_mismatch") {
    return refusal(
      "signal_denied",
      `Pid ${input.discovery.pid} now belongs to a different process; the recorded daemon was not signalled. `
        + "Remove the stale discovery file to start a new daemon.",
      "ack",
    )
  }
  if (verdict.state === "exited") {
    // Nothing was signalled, so nothing was contained: the group may still hold
    // members this process has no identity for.
    return operation("succeeded", {
      execution: { value: "terminal", source: "desktop-launcher", observedAt: now(), generation: input.discovery.generation },
      cleanup: { value: "unknown", source: "desktop-launcher", observedAt: now(), generation: input.discovery.generation },
      persistence: { value: "unavailable", source: "desktop-launcher", observedAt: now(), generation: input.discovery.generation },
    })
  }

  if (!(await input.authorize(preview))) {
    return operation(
      "needs_action",
      runningFacts(input.discovery.generation, now()),
      {
        code: "ownership_unverified",
        origin: "desktop-launcher",
        target,
        stage: "ack",
        executionMayContinue: true,
        message: "stopping this daemon has not been authorized; it is still running and no replacement was started",
        at: now(),
      },
      [{ action: "stop_daemon", scopePreviewRequired: true, reason: preview.summary }],
    )
  }

  const result = await retireLaunch({ identity: verdict.identity }, budgets)
  return retirementOutcome(result, operation, input.discovery.generation, now, target, preview)
}

function retirementOutcome(
  result: RetirementResult,
  operation: (
    state: RecoveryOperation["state"],
    facts: RecoveryFacts,
    error?: RecoveryError,
    nextActions?: RecoveryOperation["nextActions"],
  ) => DaemonRecoveryResult,
  generation: string,
  now: () => number,
  target: RecoveryMachineTarget,
  preview: RecoveryScopePreview,
): DaemonRecoveryResult {
  const at = now()
  const facts: RecoveryFacts = {
    execution: {
      value: result.leader === "exited" ? "terminal" : result.leader === "alive" ? "running" : "unknown",
      source: "desktop-launcher",
      observedAt: at,
      generation,
    },
    cleanup: {
      value: result.descendants === "verified_clear" ? "verified_clear" : result.descendants === "owned" ? "owned" : "unknown",
      source: "desktop-launcher",
      observedAt: at,
      generation,
    },
    persistence: { value: "unavailable", source: "desktop-launcher", observedAt: at, generation },
  }
  if (retirementSettled(result)) return operation("succeeded", facts)
  const error: RecoveryError = result.error
    ? { ...result.error, origin: "desktop-launcher", target, stage: "kill_verify", executionMayContinue: result.leader !== "exited", at }
    : {
        code: "exit_unverified",
        origin: "desktop-launcher",
        target,
        stage: "kill_verify",
        executionMayContinue: true,
        message: `the daemon's leader is ${result.leader} and its group is ${result.descendants} after the retirement budget`,
        at,
      }
  return operation("needs_action", facts, error, [
    { action: "stop_daemon", scopePreviewRequired: true, reason: preview.summary },
  ])
}

function runningFacts(generation: string, at: number): RecoveryFacts {
  return {
    execution: { value: "running", source: "desktop-launcher", observedAt: at, generation },
    cleanup: { value: "owned", source: "desktop-launcher", observedAt: at, generation },
    persistence: { value: "unavailable", source: "desktop-launcher", observedAt: at, generation },
  }
}

function unknownFacts(generation: string, at: number): RecoveryFacts {
  return {
    execution: { value: "unknown", source: "desktop-launcher", observedAt: at, generation },
    cleanup: { value: "unknown", source: "desktop-launcher", observedAt: at, generation },
    persistence: { value: "unavailable", source: "desktop-launcher", observedAt: at, generation },
  }
}

function isDaemonOwnershipView(value: unknown): value is DaemonOwnershipView {
  const record = asRecord(value)
  return (
    !!record &&
    isNonEmptyString(record.machineId) &&
    isNonEmptyString(record.generation) &&
    typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 &&
    isNonEmptyString(record.revision) &&
    typeof record.writtenAt === "number" && Number.isFinite(record.writtenAt) &&
    typeof record.residencyPins === "number" && Number.isFinite(record.residencyPins) &&
    Array.isArray(record.owners) &&
    record.owners.every((owner) => {
      const row = asRecord(owner)
      return !!row && isNonEmptyString(row.id) && isNonEmptyString(row.kind)
        && isNonEmptyString(row.generation) && isNonEmptyString(row.state) && typeof row.pins === "boolean"
    })
  )
}

export const DAEMON_RECOVERY_CHANNELS = {
  inspect: "daemon-recovery:inspect",
  submit: "daemon-recovery:submit",
  read: "daemon-recovery:read",
} as const

/**
 * The recovery surface the renderer reaches.
 *
 * The daemon token never leaves this process: the renderer names an operation,
 * and this forwards it over the authenticated daemon fetch. When there is no
 * daemon to forward to, the held launch result is what it answers with, and an
 * authorized stop runs the external retirement instead.
 */
export function daemonRecoveryBridge(input: {
  daemon: () => DaemonFetch | undefined
  unresolved: () => { discovery: ClaxedoDaemonDiscovery; result: DaemonRecoveryResult } | undefined
  ownershipView: () => DaemonOwnershipView | undefined
  onRecovered: (result: DaemonRecoveryResult) => void | Promise<void>
}) {
  const protocol = { [DAEMON_PROTOCOL_HEADER]: String(CLAXEDO_DAEMON_PROTOCOL) }
  return {
    async inspect(): Promise<DaemonRecoveryInspection> {
      const daemon = input.daemon()
      if (daemon) {
        const response = await daemon("/api/claxedo/daemon/recovery", { headers: protocol })
        return await response.json() as DaemonRecoveryInspection
      }
      const held = input.unresolved()
      if (!held) {
        return {
          machineId: "local",
          generation: "",
          target: { scope: "machine", machineId: "local", ownerGeneration: "" },
          scopeRevision: "",
          owners: [],
          preview: { sessions: [], resources: [], summary: "no daemon is published on this machine" },
          residencyPins: 0,
          operations: [],
          receipt: "volatile",
        }
      }
      const snapshot = input.ownershipView()
      // The same shape the daemon's own route answers, so a caller reads one
      // inspection whether or not the daemon is reachable. What differs is what
      // is in it, and the receipt says which of the two this is.
      return {
        machineId: "local",
        generation: held.discovery.generation,
        target: { scope: "machine", machineId: "local", ownerGeneration: held.discovery.generation },
        scopeRevision: snapshot?.generation === held.discovery.generation ? snapshot.revision : "unverified",
        owners: snapshot?.generation === held.discovery.generation ? snapshot.owners : [],
        preview: daemonRecoveryPreview(held.discovery, snapshot, Date.now()),
        residencyPins: snapshot?.generation === held.discovery.generation ? snapshot.residencyPins : 0,
        operations: held.result.outcome.kind === "operation" ? [held.result.outcome.operation] : [],
        receipt: "volatile",
      }
    },
    async submit(body: unknown): Promise<RecoveryOutcome> {
      // Parsed here even when it is only being forwarded: a request this
      // process cannot read is one it should not be relaying under the machine
      // capability the renderer does not hold.
      let request: RecoveryRequest
      try {
        request = parseRecoveryRequest(body)
      } catch (error) {
        if (!(error instanceof RecoveryContractError)) throw error
        return { kind: "refused", refusal: { kind: "unavailable", message: error.message } }
      }
      const daemon = input.daemon()
      if (daemon) {
        const response = await daemon("/api/claxedo/daemon/recovery", {
          method: "POST",
          headers: { ...protocol, "content-type": "application/json" },
          body: JSON.stringify(request),
        })
        return parseRecoveryOutcome(await response.text())
      }
      const held = input.unresolved()
      if (!held) {
        return {
          kind: "refused",
          refusal: { kind: "unavailable", message: "no daemon on this machine is reachable for that operation" },
        }
      }
      if (request.action !== "stop_daemon") {
        return {
          kind: "refused",
          refusal: {
            kind: "unavailable",
            message: `a daemon that is not answering can only be stopped from here, not ${request.action}`,
          },
        }
      }
      const target: RecoveryMachineTarget = {
        scope: "machine",
        machineId: "local",
        ownerGeneration: held.discovery.generation,
      }
      if (!recoveryTargetsMatch(request.target, target)) {
        return {
          kind: "refused",
          refusal: {
            kind: "generation_conflict",
            message: "the request names a different machine or daemon generation than the one published here",
            current: target,
          },
        }
      }
      const snapshot = input.ownershipView()
      const scopeRevision = snapshot?.generation === held.discovery.generation ? snapshot.revision : "unverified"
      if (request.scopeRevision !== scopeRevision) {
        return {
          kind: "refused",
          refusal: {
            kind: "scope_changed",
            message: "this daemon's last published ownership differs from the preview this stop was authorized against",
            scopeRevision,
            preview: daemonRecoveryPreview(held.discovery, snapshot, Date.now()),
          },
        }
      }
      // The caller having reached here with a matching generation and scope
      // revision IS the authorization: it was shown that preview through the
      // bridge-carrying document and named it back.
      const recovered = await recoverPublishedDaemon({
        discovery: held.discovery,
        snapshot,
        authorize: () => true,
      })
      await input.onRecovered(recovered)
      return recovered.outcome
    },
    async read(operationId: unknown): Promise<RecoveryOutcome> {
      if (typeof operationId !== "string" || operationId.length === 0) {
        return { kind: "refused", refusal: { kind: "unavailable", message: "an operation id is required" } }
      }
      const daemon = input.daemon()
      if (daemon) {
        const response = await daemon(`/api/claxedo/daemon/recovery/operations/${encodeURIComponent(operationId)}`, {
          headers: protocol,
        })
        return parseRecoveryOutcome(await response.text())
      }
      const held = input.unresolved()
      if (held?.result.outcome.kind === "operation" && held.result.outcome.operation.operationId === operationId) {
        return held.result.outcome
      }
      return {
        kind: "refused",
        refusal: { kind: "receipt_expired", message: `operation ${operationId} is not held here`, requestId: operationId },
      }
    },
  }
}
