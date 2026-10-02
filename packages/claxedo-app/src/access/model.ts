import type { OrgRole } from "@/server"

export type AccessAction = "org.manage" | "org.accounts" | "plugins.manage" | "accounts.removeOrg"

export const isOrgManager = (role: OrgRole | undefined) => role === "owner" || role === "admin"

export function sessionControls(facts: { readonly owned: boolean; readonly level?: "follow" | "send" }) {
  return {
    available: facts.owned || facts.level !== undefined,
    send: facts.owned || facts.level === "send",
    manage: facts.owned,
    shared: facts.level !== undefined,
  }
}
