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
