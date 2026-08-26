import { createMemo, Show, type Accessor } from "solid-js"
import type { JSX } from "@solidjs/web"
import { usePrincipal, type Principal } from "@/platform/auth/identity-provider"

export type RelayRole = "owner" | "admin" | "editor" | "viewer"
export type WorkspaceAuthorization = { role?: RelayRole }

export type WorkspaceCapability =
  "read.workspace" | "view.workspace-tools" | "use.terminal" | "mutate.session" | "mutate.workspace" | "manage.runners"

export type PrincipalCapability = "share.workspace" | "view.account"
export type Capability = WorkspaceCapability | PrincipalCapability

const ownerCapabilities = [
  "read.workspace",
  "view.workspace-tools",
  "use.terminal",
  "mutate.session",
  "mutate.workspace",
  "manage.runners",
] satisfies WorkspaceCapability[]

// Terminal grants arbitrary command execution, so viewers cannot use it.
export const RolePolicy: Record<RelayRole, ReadonlySet<WorkspaceCapability>> = {
  owner: new Set(ownerCapabilities),
  admin: new Set(ownerCapabilities),
  editor: new Set(["read.workspace", "view.workspace-tools", "use.terminal", "mutate.session"]),
  viewer: new Set(["read.workspace", "view.workspace-tools"]),
}

export const PrincipalPolicy: Record<Principal["kind"], ReadonlySet<PrincipalCapability>> = {
  anonymous: new Set(["view.account"]),
  local: new Set(),
  signed: new Set(["share.workspace", "view.account"]),
  "org-member": new Set(["share.workspace", "view.account"]),
}

function isPrincipalCapability(capability: Capability): capability is PrincipalCapability {
  return capability === "share.workspace" || capability === "view.account"
}

function isPrincipal(subject: WorkspaceAuthorization | Principal): subject is Principal {
  return "kind" in subject
}

export function can(capability: WorkspaceCapability, subject: WorkspaceAuthorization | undefined): boolean
export function can(capability: PrincipalCapability, subject: Principal | undefined): boolean
export function can(capability: Capability, subject: WorkspaceAuthorization | Principal | undefined): boolean
export function can(capability: Capability, subject: WorkspaceAuthorization | Principal | undefined) {
  if (!subject) return false
  if (isPrincipal(subject)) return isPrincipalCapability(capability) && PrincipalPolicy[subject.kind].has(capability)
  if (isPrincipalCapability(capability)) return false
  if (!subject.role) return false
  return RolePolicy[subject.role].has(capability)
}

export function useCan(
  capability: WorkspaceCapability,
  subject: Accessor<WorkspaceAuthorization | undefined>,
): Accessor<boolean>
export function useCan(capability: PrincipalCapability, subject: Accessor<Principal | undefined>): Accessor<boolean>
export function useCan(
  capability: Capability,
  subject: Accessor<WorkspaceAuthorization | Principal | undefined>,
): Accessor<boolean>
export function useCan(capability: Capability, subject: Accessor<WorkspaceAuthorization | Principal | undefined>) {
  return createMemo(() => can(capability, subject()))
}

export function Can(props: {
  do: Capability
  on?: WorkspaceAuthorization | Principal | undefined
  children: JSX.Element
  fallback?: JSX.Element
}) {
  const principal = props.on === undefined ? usePrincipal() : undefined
  return (
    <Show when={can(props.do, props.on ?? principal?.())} fallback={props.fallback}>
      {props.children}
    </Show>
  )
}
