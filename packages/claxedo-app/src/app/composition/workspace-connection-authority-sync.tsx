import { createEffect, onCleanup, type Component } from "solid-js"
import { useAccountPort } from "@/platform/account/account-provider"
import {
  configureWorkspaceConnectionAuthority,
  type WorkspaceConnectionAuthority,
} from "@/platform/runtime/agent/workspace-relay-connection"
import { configureWorkspaceCreateAuthority } from "@/platform/runtime/agent/workspace-create-authority"
import { createCloudWorkspace } from "@/features/workspaces/data/workspace-create-api"
import { accountRunBridge } from "@/platform/account/hosted-control-call"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"

/** Makes Electron/browser account operations the one signed connection authority. */
export const WorkspaceConnectionAuthoritySync: Component = () => {
  const account = useAccountPort()
  const authority: WorkspaceConnectionAuthority = {
    mint: (id) => account.run("workspace.connection.mint", { id }),
    refresh: (id) => account.run("workspace.connection.refresh", { id }),
  }
  // Only the desktop binds hosted operations to the account port (Electron
  // main runs them). The browser port has no operation transport, so a signed
  // web session keeps the relay connection's own HTTP mint/refresh, which
  // carries the session cookie; binding the port there would route every mint
  // into "no transport bound" and paint the workspace as failed to start.
  const bridged = accountRunBridge() !== undefined

  createEffect(() => {
    const signed = account.state().status === "signed"
    configureWorkspaceConnectionAuthority(signed && bridged ? authority : undefined)
    // Workspace creation has one transport-aware implementation:
    // `createCloudWorkspace` reaches the hosted plane through Electron main on
    // the desktop and posts with the session cookie in the browser. Bound
    // whenever a signed account exists, on every platform — and on a loopback
    // server regardless of the browser principal: that server holds the
    // hosted credentials itself (a machine enrolled with
    // `claxedo up`), so the request is its to accept or refuse.
    const loopback = centralTransportForServer(getClaxedoServerUrl()) === "loopback"
    configureWorkspaceCreateAuthority(signed || loopback ? (input) => createCloudWorkspace(input) : undefined)
  })
  onCleanup(() => {
    configureWorkspaceConnectionAuthority(undefined)
    configureWorkspaceCreateAuthority(undefined)
  })
  return null
}
