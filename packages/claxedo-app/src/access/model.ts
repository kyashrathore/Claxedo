import type { OrgRole } from "@/server"

export type AccessAction = "accounts.manageOrg" | "sandbox.manage" | "usage.teamSpend"

export type AccessFacts = { readonly canManageOrgAccounts?: boolean; readonly canManageSandboxKeys?: boolean; readonly role?: OrgRole }

export const isOrgManager = (role: OrgRole | undefined) => role === "owner" || role === "admin"

type ShareLevel = "follow" | "send"

export type SessionControls = { readonly owner: boolean; readonly send: boolean }

export const sessionControls = (share: ShareLevel | undefined): SessionControls => ({ owner: share === undefined, send: share !== "follow" })
