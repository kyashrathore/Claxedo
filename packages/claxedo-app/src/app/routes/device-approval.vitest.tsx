import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { configureAuthSession } from "@/platform/auth/auth-session"
import type { BrowserAuthState } from "@/platform/auth/browser-auth"
import DeviceApprovalPage, { readDeviceAuthorization, submitDeviceDecision } from "./device-approval"

function browserAuth(input: { signedIn: boolean; signIn: BrowserAuthState["signIn"] }): BrowserAuthState {
  return {
    descriptor: () => null,
    methods: () => [],
    session: () => null,
    user: () => null,
    loading: () => false,
    isSignedIn: () => input.signedIn,
    signIn: input.signIn,
    signOut: async () => undefined,
    signUp: async () => undefined,
    getToken: async () => null,
    refreshSession: async () => undefined,
    organization: () => undefined,
  }
}

function bindAuth(signedIn: boolean) {
  const signIn = vi.fn(async () => undefined)
  configureAuthSession(() => browserAuth({ signedIn, signIn }))
  return signIn
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  window.history.replaceState({}, "", "/device?user_code=ABCD-EFGH")
})

afterEach(() => {
  cleanup()
  configureAuthSession(null)
})

describe("device authorization boundary", () => {
  test("reads the grant the signed user owns", async () => {
    const request = vi.fn(async () => json({
      user_code: "ABCD-EFGH",
      status: "pending",
      client_id: "claxedo-cli",
      scope: "openid offline_access workspace:read",
      transaction: "f".repeat(64),
    }))

    await expect(readDeviceAuthorization("ABCD-EFGH", request as never, "https://api.example.test"))
      .resolves.toEqual({
        userCode: "ABCD-EFGH",
        status: "pending",
        clientId: "claxedo-cli",
        scopes: ["openid", "offline_access", "workspace:read"],
        transaction: "f".repeat(64),
      })
    expect(request).toHaveBeenCalledWith(
      "https://api.example.test/api/auth/device?user_code=ABCD-EFGH",
      expect.objectContaining({ credentials: "include" }),
    )
  })

  test("raises the authorization server's description for an expired code", async () => {
    const request = vi.fn(async () => json({ error: "expired_token", error_description: "User code expired" }, 400))

    await expect(readDeviceAuthorization("ABCD-EFGH", request as never, "https://api.example.test"))
      .rejects.toThrow("User code expired")
  })

  test("posts the decision, and the transaction the server handed this page, to the approve and deny endpoints", async () => {
    const request = vi.fn(async () => json({ success: true }))
    const loaded = {
      userCode: "ABCD-EFGH",
      status: "pending",
      scopes: [],
      transaction: "f".repeat(64),
    } as const

    await submitDeviceDecision({ request: loaded, approve: true }, request as never, "https://api.example.test")
    await submitDeviceDecision({ request: loaded, approve: false }, request as never, "https://api.example.test")

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.test/api/auth/device/approve",
      "https://api.example.test/api/auth/device/deny",
    ])
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ userCode: "ABCD-EFGH", transaction: "f".repeat(64) }),
    })
  })
})

describe("DeviceApprovalPage", () => {
  test("shows the requesting client and its scopes, then approves", async () => {
    bindAuth(true)
    const submit = vi.fn(async () => undefined)
    render(() => (
      <DeviceApprovalPage
        request={vi.fn() as never}
        apiOrigin="https://api.example.test"
        load={async () => ({
          userCode: "ABCD-EFGH",
          status: "pending",
          clientId: "claxedo-cli",
          scopes: ["workspace:read"],
          transaction: "f".repeat(64),
        })}
        submit={submit}
      />
    ))

    expect(await screen.findByText("claxedo-cli")).toBeInTheDocument()
    expect(screen.getByText("workspace:read")).toBeInTheDocument()
    expect(screen.getByTestId("device-user-code")).toHaveTextContent("ABCD-EFGH")

    fireEvent.click(screen.getByRole("button", { name: "Approve" }))

    await waitFor(() => expect(submit).toHaveBeenCalledWith({
      request: {
        userCode: "ABCD-EFGH",
        status: "pending",
        clientId: "claxedo-cli",
        scopes: ["workspace:read"],
        transaction: "f".repeat(64),
      },
      approve: true,
    }))
    expect(await screen.findByText("Device connected")).toBeInTheDocument()
  })

  test("cannot decide before the grant is read", () => {
    bindAuth(true)
    render(() => (
      <DeviceApprovalPage
        request={vi.fn() as never}
        apiOrigin="https://api.example.test"
        load={() => new Promise(() => {})}
        submit={vi.fn()}
      />
    ))

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled()
  })

  test("sends an anonymous visitor through sign-in and back to this link", async () => {
    const signIn = bindAuth(false)
    const load = vi.fn()
    render(() => (
      <DeviceApprovalPage
        request={vi.fn() as never}
        apiOrigin="https://api.example.test"
        load={load as never}
        submit={vi.fn()}
      />
    ))

    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ redirectUrl: window.location.href }))
    expect(load).not.toHaveBeenCalled()
  })

  test("refuses a link that carries no device code", () => {
    window.history.replaceState({}, "", "/device")
    bindAuth(true)
    render(() => (
      <DeviceApprovalPage request={vi.fn() as never} apiOrigin="https://api.example.test" load={vi.fn() as never} submit={vi.fn()} />
    ))

    expect(screen.getByRole("alert")).toHaveTextContent("missing its device code")
  })
})
