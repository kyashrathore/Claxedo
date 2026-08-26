import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  status: "unsigned" as "unsigned" | "pending" | "signed",
  signIn: vi.fn(async () => {}),
  navigate: vi.fn(),
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
})
