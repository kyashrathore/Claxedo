import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import OAuthConsentPage, { submitOAuthConsent } from "./oauth-consent"

beforeEach(() => {
  window.history.replaceState({}, "", "/oauth/consent?scope=offline_access+workspace%3Aread+workspace%3Awrite&sig=signed")
})

afterEach(() => cleanup())

describe("OAuthConsentPage", () => {
  test("posts the complete signed query and returns the server-owned redirect", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      redirect: true,
      url: "http://127.0.0.1:65000/claxedo/auth/callback?code=code_1&state=state_1",
    }), { status: 200, headers: { "content-type": "application/json" } }))

    await expect(submitOAuthConsent(
      { accept: true, oauthQuery: "?scope=workspace%3Aread&sig=signed" },
      request,
      "https://api.example.test",
    ))
      .resolves.toBe("http://127.0.0.1:65000/claxedo/auth/callback?code=code_1&state=state_1")
    expect(request).toHaveBeenCalledWith("https://api.example.test/api/auth/oauth2/consent", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ accept: true, oauth_query: "?scope=workspace%3Aread&sig=signed" }),
    }))
  })

  test("shows requested scopes and submits allow through the consent boundary", async () => {
    const submit = vi.fn(async () => "http://127.0.0.1:65000/claxedo/auth/callback?code=code_1")
    const redirect = vi.fn()
    render(() => (
      <OAuthConsentPage
        request={vi.fn() as never}
        apiOrigin="https://api.example.test"
        submit={submit}
        redirect={redirect}
      />
    ))

    expect(screen.getByText("offline_access")).toBeInTheDocument()
    expect(screen.getByText("workspace:read")).toBeInTheDocument()
    expect(screen.getByText("workspace:write")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Allow" }))

    await waitFor(() => expect(submit).toHaveBeenCalledWith({
      accept: true,
      oauthQuery: window.location.search,
    }))
    expect(redirect).toHaveBeenCalledWith("http://127.0.0.1:65000/claxedo/auth/callback?code=code_1")
  })

  test("keeps authorization errors on the consent page", async () => {
    render(() => (
      <OAuthConsentPage
        request={vi.fn() as never}
        apiOrigin="https://api.example.test"
        submit={async () => {
          throw new Error("Authorization expired")
        }}
        redirect={vi.fn()}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "Allow" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Authorization expired")
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled()
  })
})
