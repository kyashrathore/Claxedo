import { cleanup, render } from "@solidjs/testing-library"
import { createMemo, onMount } from "solid-js"
import { afterEach, describe, expect, test } from "vitest"
import { submitBlockedByRole } from "../../features/session/composer/role-gate"
import {
  __workspaceConnectionInternals as internals,
  acquireWorkspaceConnection,
  workspacePlacement,
} from "@/features/workspaces/data/workspace-connection"
import type { WorkspaceConnectionInfo } from "@/platform/runtime/agent/workspace-relay-connection"
import { Can } from "./role"

afterEach(() => {
  cleanup()
  internals.reset()
})

describe("viewer read-only role gates", () => {
  const relayInfo = (role: WorkspaceConnectionInfo["role"]): WorkspaceConnectionInfo => ({
    access: "cloud",
    backing: "cloud-vm",
    workspaceId: "ws_readonly",
    role,
    relayUrl: "https://relay.example.test",
    runtimeAccessToken: "token",
    tokenExpiresAt: Date.now() + 60_000,
  })

  test("viewer disables submit and hides mutating controls without remounting on role flip", () => {
    let mounts = 0
    acquireWorkspaceConnection({
      workspaceId: "ws_readonly",
      kind: "user-hosted",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    })
    internals.applyWorkspaceConnectionInfo(relayInfo("viewer"))

    const Surface = () => {
      onMount(() => {
        mounts += 1
      })
      const submitBlocked = createMemo(() => submitBlockedByRole(workspacePlacement("ws_readonly")))
      return (
        <section>
          <button data-testid="submit" disabled={submitBlocked()}>Send</button>
          <Can do="mutate.workspace" on={workspacePlacement("ws_readonly")}>
            <button data-testid="delete">Delete workspace</button>
          </Can>
        </section>
      )
    }

    const view = render(() => <Surface />)
    expect((view.getByTestId("submit") as HTMLButtonElement).disabled).toBe(true)
    expect(view.queryByTestId("delete")).toBeNull()
    expect(mounts).toBe(1)

    internals.applyWorkspaceConnectionInfo(relayInfo("owner"))
    expect((view.getByTestId("submit") as HTMLButtonElement).disabled).toBe(false)
    expect(view.getByTestId("delete")).toBeTruthy()
    expect(mounts).toBe(1)
  })
})
