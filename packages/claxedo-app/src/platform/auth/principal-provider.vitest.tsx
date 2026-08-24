import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AuthSessionStatus } from "./auth-session"
import type { Principal } from "./identity-provider"

const authState = vi.hoisted(() => ({
  status: "anonymous" as AuthSessionStatus,
  user: undefined as { id?: string } | undefined,
  organization: undefined as { id?: string } | null | undefined,
}))

vi.mock("./auth-session", () => ({
  useAuthSession: () => ({
    status: () => authState.status,
    session: () => (authState.status === "signed" ? { id: "sess_1" } : null),
    user: () => authState.user,
    signIn: async () => undefined,
    signOut: async () => undefined,
    signUp: async () => undefined,
    refreshSession: async () => undefined,
    organization: () => authState.organization,
  }),
}))

import { usePrincipal } from "./identity-provider"
import { PrincipalProvider } from "./principal-provider"

beforeEach(() => {
  authState.status = "anonymous"
  authState.user = undefined
  authState.organization = undefined
})

afterEach(() => cleanup())

describe("PrincipalProvider", () => {
  test("uses a local principal when auth is disabled and no user is signed in", () => {
    expect(renderPrincipal(false)).toEqual({ kind: "local", deviceId: "local" })
  })

  test("keeps signed identity when auth is disabled for local or staging shells", () => {
    authState.status = "signed"
    authState.user = { id: "usr_1" }

    expect(renderPrincipal(false)).toEqual({
      kind: "signed",
      userId: "usr_1",
    })
  })

  test("uses an anonymous principal when auth is enabled and no user is signed in", () => {
    expect(renderPrincipal(true)).toEqual({ kind: "anonymous" })
  })

  test("uses an organization principal when the signed session has an active organization", () => {
    authState.status = "signed"
    authState.user = { id: "usr_1" }
    authState.organization = { id: "org_1" }

    expect(renderPrincipal(true)).toEqual({
      kind: "org-member",
      userId: "usr_1",
      orgId: "org_1",
      memberships: [],
    })
  })
})

function renderPrincipal(authEnabled: boolean) {
  let value: Principal | undefined
  function Probe() {
    value = usePrincipal()()
    return <div />
  }

  render(() => (
    <PrincipalProvider authEnabled={authEnabled}>
      <Probe />
    </PrincipalProvider>
  ))

  return value
}
