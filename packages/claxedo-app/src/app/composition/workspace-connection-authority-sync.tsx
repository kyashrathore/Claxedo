import { createEffect, onCleanup, type Component } from "solid-js"
import { useAccountPort } from "@/platform/account/account-provider"
import {
  configureWorkspaceConnectionAuthority,
  type WorkspaceConnectionAuthority,
} from "@/platform/runtime/agent/workspace-relay-connection"

/** Makes Electron/browser account operations the one signed connection authority. */
export const WorkspaceConnectionAuthoritySync: Component = () => {
  const account = useAccountPort()
  const authority: WorkspaceConnectionAuthority = {
    mint: (id) => account.run("workspace.connection.mint", { id }),
    refresh: (id) => account.run("workspace.connection.refresh", { id }),
  }

  createEffect(() => {
    configureWorkspaceConnectionAuthority(account.state().status === "signed" ? authority : undefined)
  })
  onCleanup(() => configureWorkspaceConnectionAuthority(undefined))
  return null
}
