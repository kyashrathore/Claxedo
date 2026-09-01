import { createEffect, onCleanup, type Component } from "solid-js"
import { useAccountPort } from "@/platform/account/account-provider"
import {
  configureWorkspaceConnectionAuthority,
  type WorkspaceConnectionAuthority,
} from "@/platform/runtime/agent/workspace-relay-connection"
import { configureWorkspaceCreateAuthority } from "@/platform/runtime/agent/workspace-create-authority"

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
    configureWorkspaceCreateAuthority(signed
      ? ({ repo, ...rest }) => account.run("workspace.create", {
        ...rest,
        // Operation parameters are scalars, so the connected-repository source
        // travels flat. Electron main re-nests `repoFullName` into the
        // `{ fullName }` object the hosted create schema requires.
        ...(repo?.fullName ? { repoFullName: repo.fullName } : {}),
      })
      : undefined)
  })
  onCleanup(() => {
    configureWorkspaceConnectionAuthority(undefined)
    configureWorkspaceCreateAuthority(undefined)
  })
  return null
}
