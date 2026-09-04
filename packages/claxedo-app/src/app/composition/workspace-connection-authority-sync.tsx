import { createEffect, onCleanup, type Component } from "solid-js"
import { useAccountPort } from "@/platform/account/account-provider"
import {
  configureWorkspaceConnectionAuthority,
  type WorkspaceConnectionAuthority,
} from "@/platform/runtime/agent/workspace-relay-connection"
import { configureWorkspaceCreateAuthority } from "@/platform/runtime/agent/workspace-create-authority"
import { createCloudWorkspace } from "@/features/workspaces/data/workspace-create-api"

/** Makes Electron/browser account operations the one signed connection authority. */
export const WorkspaceConnectionAuthoritySync: Component = () => {
  const account = useAccountPort()
  const authority: WorkspaceConnectionAuthority = {
    mint: (id) => account.run("workspace.connection.mint", { id }),
    refresh: (id) => account.run("workspace.connection.refresh", { id }),
  }

  createEffect(() => {
    const signed = account.state().status === "signed"
    configureWorkspaceConnectionAuthority(signed ? authority : undefined)
    // Workspace creation has one transport-aware implementation:
    // `createCloudWorkspace` reaches the hosted plane through Electron main on
    // the desktop and posts with the session cookie in the browser. Bound
    // whenever a signed account exists, on every platform.
    configureWorkspaceCreateAuthority(signed ? (input) => createCloudWorkspace(input) : undefined)
  })
  onCleanup(() => {
    configureWorkspaceConnectionAuthority(undefined)
    configureWorkspaceCreateAuthority(undefined)
  })
  return null
}
