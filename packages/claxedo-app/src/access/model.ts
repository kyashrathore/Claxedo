import type { OrgRole } from "@/server"

export type AccessAction = "org.manage" | "org.accounts" | "plugins.manage" | "accounts.removeOrg" | "sandbox.manage"

export type AccessFacts = { readonly canRemoveOrgAccounts?: boolean; readonly canManageSandboxKeys?: boolean }

export const isOrgManager = (role: OrgRole | undefined) => role === "owner" || role === "admin"

type ShareLevel = "follow" | "send"

export type SessionControls = { readonly owner: boolean; readonly send: boolean }

export const sessionControls = (share: ShareLevel | undefined): SessionControls => ({ owner: share === undefined, send: share !== "follow" })
