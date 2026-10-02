import type { OrgRole } from "@/server"

export type AccessAction = "org.manage" | "org.accounts" | "plugins.manage" | "accounts.removeOrg"

export const isOrgManager = (role: OrgRole | undefined) => role === "owner" || role === "admin"

type ShareLevel = "follow" | "send"

export const sessionControls = (share: ShareLevel | undefined) => ({ owner: share === undefined, send: share !== "follow" })
