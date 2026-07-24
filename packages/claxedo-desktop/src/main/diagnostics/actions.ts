import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

import type {
  DiagnosticsOperationResult,
  DiagnosticsOwnerDescriptor,
} from "../../shared/diagnostics-transport"
import { sameCreationIdentity } from "./process-identity"

export type OwnerOperation = (input: {
  action: LocalDiagnostics.ActionKind
  identity: LocalDiagnostics.ProcessIdentity
  owner: DiagnosticsOwnerDescriptor
}) => Promise<DiagnosticsOperationResult["result"]>

export type ActionClaim = {
  action: LocalDiagnostics.ActionKind
  ownerId: string
  ownerGeneration: string
  ownerOperationId: string
  ownerLabel: string
  identity: LocalDiagnostics.ProcessIdentity
  profilerGeneration: string
}

type OwnerRecord = {
  descriptor: DiagnosticsOwnerDescriptor
  operation?: OwnerOperation
  detached: boolean
}

type TokenRecord = {
  token: string
  expiresAt: number
  claim: ActionClaim
}

const protectedKinds = new Set<LocalDiagnostics.OwnerKind>([
  "app",
  "electron-main",
  "renderer",
  "gpu",
  "utility",
  "server",
  "runtime",
  "unmapped",
  "external",
])

export function createDiagnosticsActions(options: {
  generation: string
  now?: () => number
  token?: () => string
  ttlMs?: number
  maxTokens?: number
}) {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 15_000
  const maxTokens = options.maxTokens ?? 1_024
  const owners = new Map<string, OwnerRecord>()
  const tokens = new Map<string, TokenRecord>()
  const grants = new Map<string, TokenRecord>()

  return {
    register(descriptor: DiagnosticsOwnerDescriptor, operation?: OwnerOperation) {
      revokeOwner(descriptor.ownerId)
      owners.set(descriptor.ownerId, { descriptor, operation, detached: false })
    },
    update(input: {
      ownerId: string
      ownerGeneration: string
      lifecycle: "starting" | "ready" | "detached"
      pid?: number
    }) {
      const owner = owners.get(input.ownerId)
      if (!owner || owner.descriptor.ownerGeneration !== input.ownerGeneration) return
      if (input.pid !== undefined && owner.descriptor.pid !== undefined && input.pid !== owner.descriptor.pid) {
        revokeOwner(input.ownerId)
        return
      }
      if (input.pid !== undefined) owner.descriptor = { ...owner.descriptor, pid: input.pid }
      owner.detached = input.lifecycle === "detached"
      if (owner.detached) revokeTokens(input.ownerId)
    },
    exit(ownerId: string, ownerGeneration: string) {
      const owner = owners.get(ownerId)
      if (!owner || owner.descriptor.ownerGeneration !== ownerGeneration) return
      revokeOwner(ownerId)
    },
    eligibility(
      process: LocalDiagnostics.ProcessRecord,
      owner: LocalDiagnostics.OwnerIdentity | undefined,
    ): LocalDiagnostics.ActionEligibility {
      if (!owner || !process.ownerId) return { state: "ineligible", reason: "unregistered-owner" }
      if (owner.lifecycle === "historical" || process.lifecycle === "exited") {
        return { state: "ineligible", reason: "historical" }
      }
      if (owner.access === "remote") return { state: "ineligible", reason: "remote" }
      if (protectedKinds.has(owner.kind)) return { state: "ineligible", reason: "protected-process" }
      const record = owners.get(process.ownerId)
      if (!record) return { state: "ineligible", reason: "unregistered-owner" }
      if (record.detached) return { state: "ineligible", reason: "detached" }
      if (!record.operation || record.descriptor.pid !== process.identity.pid) {
        return { state: "ineligible", reason: "owner-operation-unavailable" }
      }
      if (
        process.identity.creation.state !== "available" ||
        !["linux-proc", "windows-cim"].includes(process.identity.creation.source) ||
        !process.identity.launchId ||
        process.identity.launchId !== record.descriptor.launchId
      ) return { state: "ineligible", reason: "identity-unavailable" }

      const actions = ([
        record.descriptor.capabilities.stopGracefully ? "stop" : undefined,
        record.descriptor.capabilities.killOwnedTree ? "kill" : undefined,
      ] as const).filter((action): action is LocalDiagnostics.ActionKind => action !== undefined)
      if (actions.length === 0) return { state: "ineligible", reason: "owner-operation-unavailable" }
      return {
        state: "eligible",
        actions: actions.map((action) => grant(action, process, owner, record)),
      }
    },
    claim(request: LocalDiagnostics.ActionRequest):
      | { ok: true; claim: ActionClaim }
      | { ok: false; result: LocalDiagnostics.ActionResult } {
      const record = tokens.get(request.token)
      if (!record) return failure(request.action, "invalid-token")
      tokens.delete(request.token)
      grants.forEach((grant, key) => {
        if (grant.token === request.token) grants.delete(key)
      })
      if (record.claim.action !== request.action) return failure(request.action, "invalid-token")
      if (record.expiresAt < now()) return failure(request.action, "expired-token")
      if (record.claim.profilerGeneration !== options.generation) {
        return failure(request.action, "stale-generation")
      }
      return { ok: true, claim: record.claim }
    },
    async execute(input: {
      claim: ActionClaim
      resolveProcess(processId: string): LocalDiagnostics.ProcessRecord | undefined
      revalidate(identity: LocalDiagnostics.ProcessIdentity): Promise<boolean>
    }): Promise<
      | { ok: true }
      | { ok: false; code: Extract<LocalDiagnostics.ActionResult, { ok: false }>["code"] }
    > {
      const owner = owners.get(input.claim.ownerId)
      if (
        !owner ||
        owner.detached ||
        owner.descriptor.ownerGeneration !== input.claim.ownerGeneration ||
        owner.descriptor.ownerOperationId !== input.claim.ownerOperationId ||
        owner.descriptor.launchId !== input.claim.identity.launchId
      ) return { ok: false, code: "owner-unavailable" }
      const process = input.resolveProcess(input.claim.identity.id)
      if (!process || process.lifecycle === "exited") return { ok: false, code: "already-exited" }
      if (!sameIdentity(process.identity, input.claim.identity)) {
        return { ok: false, code: "identity-mismatch" }
      }
      if (!await input.revalidate(input.claim.identity)) {
        return { ok: false, code: "identity-mismatch" }
      }
      if (!owner.operation) return { ok: false, code: "owner-unavailable" }
      const result = await owner.operation({
        action: input.claim.action,
        identity: input.claim.identity,
        owner: owner.descriptor,
      })
      if (result === "completed") return { ok: true }
      if (result === "identity-mismatch") return { ok: false, code: "identity-mismatch" }
      if (result === "owner-unavailable") return { ok: false, code: "owner-unavailable" }
      if (result === "operation-unavailable") return { ok: false, code: "not-eligible" }
      return { ok: false, code: "operation-failed" }
    },
    revokeAll() {
      owners.clear()
      tokens.clear()
      grants.clear()
    },
  }

  function grant(
    action: LocalDiagnostics.ActionKind,
    process: LocalDiagnostics.ProcessRecord,
    owner: LocalDiagnostics.OwnerIdentity,
    record: OwnerRecord,
  ): LocalDiagnostics.ActionGrant {
    const key = [
      record.descriptor.ownerId,
      record.descriptor.ownerGeneration,
      process.identity.id,
      action,
    ].join(":")
    const current = grants.get(key)
    if (current && current.expiresAt > now() + 1_000) {
      return { action, token: current.token, expiresAt: current.expiresAt }
    }
    const created: TokenRecord = {
      token: options.token?.() ?? crypto.randomUUID(),
      expiresAt: now() + ttlMs,
      claim: {
        action,
        ownerId: record.descriptor.ownerId,
        ownerGeneration: record.descriptor.ownerGeneration,
        ownerOperationId: record.descriptor.ownerOperationId,
        ownerLabel: owner.label,
        identity: process.identity,
        profilerGeneration: options.generation,
      },
    }
    grants.set(key, created)
    tokens.set(created.token, created)
    while (tokens.size > maxTokens) {
      const oldest = tokens.keys().next().value
      if (!oldest) break
      tokens.delete(oldest)
      grants.forEach((grant, grantKey) => {
        if (grant.token === oldest) grants.delete(grantKey)
      })
    }
    return { action, token: created.token, expiresAt: created.expiresAt }
  }

  function revokeOwner(ownerId: string) {
    owners.delete(ownerId)
    revokeTokens(ownerId)
  }

  function revokeTokens(ownerId: string) {
    tokens.forEach((record, token) => {
      if (record.claim.ownerId === ownerId) tokens.delete(token)
    })
    grants.forEach((record, key) => {
      if (record.claim.ownerId === ownerId) grants.delete(key)
    })
  }
}

function sameIdentity(current: LocalDiagnostics.ProcessIdentity, expected: LocalDiagnostics.ProcessIdentity) {
  return (
    current.id === expected.id &&
    current.pid === expected.pid &&
    current.domain === expected.domain &&
    current.launchId === expected.launchId &&
    sameCreationIdentity(current.creation, expected.creation)
  )
}

function failure(
  action: LocalDiagnostics.ActionKind,
  code: Extract<LocalDiagnostics.ActionResult, { ok: false }>["code"],
) {
  return { ok: false as const, result: { ok: false as const, action, code } }
}
