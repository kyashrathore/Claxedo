import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  status: "unsigned" as "unsigned" | "pending" | "signed",
  methods: ["clerk"] as Array<"clerk" | "google" | "github" | "email-password">,
  signIn: vi.fn(async () => {}),
  navigate: vi.fn(),
}))

vi.mock("@/platform/auth/auth-session", () => ({
  useAuthSession: () => ({ methods: () => state.methods }),
}))

vi.mock("@/platform/account/account-provider", () => ({
  useAccountPort: () => ({
    state: () =>
      state.status === "signed" ? { status: "signed", identity: { userId: "user_1" } } : { status: state.status },
    signIn: state.signIn,
    signOut: vi.fn(async () => {}),
    run: vi.fn(async () => undefined),
  }),
}))

vi.mock("@solidjs/router", () => ({
  useNavigate: () => state.navigate,
}))

import LoginPage from "./login"

beforeEach(() => {
  state.status = "unsigned"
  state.methods = ["clerk"]
  state.signIn.mockClear()
  state.navigate.mockClear()
})

afterEach(() => cleanup())

describe("LoginPage account boundary", () => {
  test("starts sign-in through the tokenless account port", async () => {
    render(() => <LoginPage />)

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(state.signIn).toHaveBeenCalledOnce())
  })

  test("returns an already signed account to the requested route", async () => {
    state.status = "signed"
    render(() => <LoginPage redirectUrl="/workspace/ws_1" />)

    await waitFor(() => expect(state.navigate).toHaveBeenCalledWith("/workspace/ws_1", { replace: true }))
  })

  test("renders and submits only the methods selected by the live Better Auth descriptor", async () => {
    state.methods = ["github", "email-password"]
    render(() => <LoginPage redirectUrl="/workspace/ws_1" />)

    expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("Email")).toBeInTheDocument()
    expect(screen.getByLabelText("Password")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Continue with GitHub" }))
    await waitFor(() =>
      expect(state.signIn).toHaveBeenCalledWith({
        method: "github",
        redirectUrl: "/workspace/ws_1",
      }),
    )
  })
})
