import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import OAuthConsentPage, { readOAuthConsentClient, submitOAuthConsent } from "./oauth-consent"

const MCP_QUERY = "/oauth/consent?client_id=aBcD&scope=offline_access+claxedo%3Aread+claxedo%3Aact+claxedo%3Aapprove+claxedo%3Aadmin&sig=signed"

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

describe("MCP consent", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", MCP_QUERY)
  })

  test("reads the requesting client's public metadata", async () => {
    const request = vi.fn(async () => new Response(
      JSON.stringify({ client_id: "aBcD", client_name: "Cursor" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ))

    await expect(readOAuthConsentClient("aBcD", request as never, "https://api.example.test"))
      .resolves.toEqual({ clientId: "aBcD", name: "Cursor" })
    expect(request).toHaveBeenCalledWith(
      "https://api.example.test/api/auth/oauth2/public-client?client_id=aBcD",
      expect.objectContaining({ credentials: "include" }),
    )
  })

  test("names the client and grants read and act without admin", async () => {
    const submit = vi.fn(async () => "http://127.0.0.1:65000/cb?code=code_1")
    render(() => (
      <OAuthConsentPage
        request={vi.fn() as never}
        apiOrigin="https://api.example.test"
        loadClient={async () => ({ clientId: "aBcD", name: "Cursor" })}
        submit={submit}
        redirect={vi.fn()}
      />
    ))

    expect(await screen.findByText("Allow Cursor?")).toBeInTheDocument()
    expect(screen.getByLabelText("Read sessions, workspaces and what needs you")).toBeChecked()
    expect(screen.getByLabelText("Start sessions and send prompts")).toBeChecked()
    expect(screen.getByLabelText("Answer permission prompts on your behalf")).not.toBeChecked()
    expect(screen.queryByLabelText("Create and destroy workspaces")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Allow" }))

    await waitFor(() => expect(submit).toHaveBeenCalledWith({
      accept: true,
      oauthQuery: window.location.search,
      scope: "offline_access claxedo:read claxedo:act",
    }))
  })

  test("grants a scope the user adds", async () => {
    const submit = vi.fn(async () => "http://127.0.0.1:65000/cb?code=code_1")
    render(() => (
      <OAuthConsentPage
        request={vi.fn() as never}
        apiOrigin="https://api.example.test"
        loadClient={async () => ({ clientId: "aBcD" })}
        submit={submit}
        redirect={vi.fn()}
      />
    ))

    fireEvent.click(await screen.findByLabelText("Answer permission prompts on your behalf"))
    fireEvent.click(screen.getByRole("button", { name: "Allow" }))

    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      scope: "offline_access claxedo:read claxedo:act claxedo:approve",
    })))
  })

  test("offers admin only to a client this deployment registered", async () => {
    window.history.replaceState({}, "", MCP_QUERY.replace("client_id=aBcD", "client_id=claxedo-cli"))
    render(() => (
      <OAuthConsentPage
        request={vi.fn() as never}
        apiOrigin="https://api.example.test"
        loadClient={async () => ({ clientId: "claxedo-cli", name: "Claxedo CLI" })}
        submit={vi.fn()}
        redirect={vi.fn()}
      />
    ))

    expect(await screen.findByLabelText("Create and destroy workspaces")).not.toBeChecked()
  })
})
