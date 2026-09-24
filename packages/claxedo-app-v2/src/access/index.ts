import type { Accessor } from "solid-js"
import type { Principal, SessionRef } from "@/server"

export type AccessAction =
  | "session.prompt"
  | "session.manageShares"
  | "org.manage"
  | "org.accounts"
  | "machine.operate"
  | "plugins.manage"

export type Access = {
  readonly principal: Accessor<Principal | undefined>
  readonly can: (action: AccessAction, subject?: SessionRef) => boolean
}

export type {
  OrgMember,
  OrgMembers,
  SessionCapabilities,
  SessionShare,
  SessionShares,
  ShareLevel,
  ShareRecipient,
  ShareRequest,
} from "./model"
export type { AccessStore, SessionAccessFacts } from "./store"
export { AccessProvider, useAccess } from "./provider"
export { SessionShareControl } from "./view/share-control"
export { organizationSettingsSection } from "./section"
