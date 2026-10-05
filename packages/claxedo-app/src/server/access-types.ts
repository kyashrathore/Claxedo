import type { MachineId, OrgId, UserId } from "./ids"

export type OrgRole = "owner" | "admin" | "member"

export type MachinePrincipal = { readonly kind: "machine"; readonly machineId?: MachineId }

export type UserPrincipal = {
  readonly kind: "user"
  readonly userId: UserId
  readonly name: string
  readonly email?: string
}

export type Principal = MachinePrincipal | UserPrincipal

export type OrgMembership = { readonly orgId: OrgId; readonly name: string; readonly role: OrgRole }

export type OrgMember = { readonly userId: UserId; readonly name?: string; readonly role: OrgRole; readonly you: boolean }
