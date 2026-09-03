import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  signed: true,
  signIn: vi.fn(async () => {}),
  navigate: vi.fn(),
  authFetch: vi.fn(async () => new Response(JSON.stringify({
    user: { id: "better-auth-user-01" },
    organizations: [{ id: "org-deployment", name: "Deployment" }],
  }), { status: 200, headers: { "content-type": "application/json" } })),
}))

vi.mock("@/platform/account/account-provider", () => ({
  useAccountPort: () => ({
    state: () => state.signed
      ? { status: "signed", identity: { userId: "better-auth-user-01" } }
      : { status: "unsigned" },
    signIn: state.signIn,
  }),
}))
vi.mock("@/platform/api/api", () => ({
  authFetch: state.authFetch,
  getClaxedoServerUrl: () => "https://api.example.test",
}))
vi.mock("@solidjs/router", () => ({ useNavigate: () => state.navigate }))

import BootstrapOwnerPage from "./bootstrap-owner"

beforeEach(() => {
  state.signed = true
  state.signIn.mockClear()
  state.navigate.mockClear()
  state.authFetch.mockClear()
})
afterEach(() => cleanup())

describe("bootstrap owner page", () => {
  test("keeps the claim out of URLs and sends it once to the explicit activation route", async () => {
    render(() => <BootstrapOwnerPage />)
    expect(screen.getByText("better-auth-user-01")).toBeInTheDocument()
    fireEvent.input(screen.getByLabelText("One-time owner claim"), { target: { value: "claim-secret" } })
    fireEvent.input(screen.getByLabelText("Canary journey ID"), { target: { value: "journey-1" } })
    fireEvent.input(screen.getByLabelText("Canary mutation operation ID"), { target: { value: "operation-1" } })
    fireEvent.click(screen.getByRole("button", { name: "Activate owner" }))

    await waitFor(() => expect(state.authFetch).toHaveBeenCalledOnce())
    const [url, init] = state.authFetch.mock.calls[0]!
    expect(String(url)).toBe("https://api.example.test/api/claxedo/auth/bootstrap-owner")
    expect(String(url)).not.toContain("claim-secret")
    expect(init?.method).toBe("POST")
    const headers = new Headers(init?.headers)
    expect(headers.get("x-claxedo-bootstrap-owner-claim")).toBe("claim-secret")
    expect(headers.get("x-claxedo-canary-journey-id")).toBe("journey-1")
    expect(headers.get("x-claxedo-canary-mutation-operation-id")).toBe("operation-1")
    await waitFor(() => expect(state.navigate).toHaveBeenCalledWith("/", { replace: true }))
  })

  test("requires authentication before accepting a claim", async () => {
    state.signed = false
    render(() => <BootstrapOwnerPage />)
    expect(screen.queryByLabelText("One-time owner claim")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Sign in to continue" }))
    await waitFor(() => expect(state.signIn).toHaveBeenCalledWith({ redirectUrl: window.location.href }))
    expect(state.authFetch).not.toHaveBeenCalled()
  })
})
