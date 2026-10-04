import type { PluginCapability, PluginManifest } from "@claxedo/plugin-api"
import { unreachable } from "@/lib/machine"

export type PluginAccess = {
  readonly routes: readonly string[]
  readonly operations: readonly string[]
  readonly requires: readonly PluginCapability[]
}

export type Approval = { readonly access: PluginAccess; readonly hash: string; readonly approvedAt: string }

export type AccessChange = { readonly added: PluginAccess; readonly removed: PluginAccess }

export type ApprovalCheck =
  | { readonly kind: "approved" }
  | { readonly kind: "unapproved" }
  | { readonly kind: "accessChanged"; readonly change: AccessChange }
  | { readonly kind: "codeChanged"; readonly builtAt: string }

export type ApprovalSubject = { readonly manifest: PluginManifest; readonly hash: string; readonly builtAt: string }

export function accessOf(manifest: PluginManifest): PluginAccess {
  return { routes: manifest.server.routes, operations: manifest.server.operations, requires: manifest.requires }
}

function missingFrom<T>(list: readonly T[], other: readonly T[]): readonly T[] {
  return list.filter((entry) => !other.includes(entry))
}

function isEmpty(access: PluginAccess): boolean {
  return access.routes.length === 0 && access.operations.length === 0 && access.requires.length === 0
}

export function accessChange(approved: PluginAccess, current: PluginAccess): AccessChange | undefined {
  const added = {
    routes: missingFrom(current.routes, approved.routes),
    operations: missingFrom(current.operations, approved.operations),
    requires: missingFrom(current.requires, approved.requires),
  }
  const removed = {
    routes: missingFrom(approved.routes, current.routes),
    operations: missingFrom(approved.operations, current.operations),
    requires: missingFrom(approved.requires, current.requires),
  }
  return isEmpty(added) && isEmpty(removed) ? undefined : { added, removed }
}

export function approvalCheck(approval: Approval | undefined, subject: ApprovalSubject): ApprovalCheck {
  if (!approval) return { kind: "unapproved" }
  const change = accessChange(approval.access, accessOf(subject.manifest))
  if (change) return { kind: "accessChanged", change }
  if (approval.hash === subject.hash) return { kind: "approved" }
  return { kind: "codeChanged", builtAt: subject.builtAt }
}

export function approvalLetsRun(check: ApprovalCheck): boolean {
  switch (check.kind) {
    case "approved":
    case "codeChanged":
      return true
    case "unapproved":
    case "accessChanged":
      return false
    default:
      return unreachable(check)
  }
}

export function approvalFor(subject: ApprovalSubject, now: Date): Approval {
  return { access: accessOf(subject.manifest), hash: subject.hash, approvedAt: now.toISOString() }
}
