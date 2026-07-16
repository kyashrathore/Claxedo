import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { AIConnectSurface } from "./ai-connect-surface"
import type { AIConnectRequest } from "./ai-connect-api"

function requests(responses: Response[]) {
  const calls: Array<{ input: Parameters<AIConnectRequest>[0]; init?: RequestInit }> = []
  const request: AIConnectRequest = async (input, init) => {
    calls.push({ input, init })
    const response = responses.shift()
    if (!response) throw new Error("unexpected request")
    return response
  }
  return { calls, request }
}

describe("AIConnectSurface", () => {
  test("gives desktop discovery and API-key entry equal prominence with honest support copy", () => {
    render(() => <AIConnectSurface localDiscovery request={vi.fn()} invalidateQueries={vi.fn()} />)

    expect(screen.getByRole("heading", { name: "Detect on this machine" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Enter an API key" })).toBeInTheDocument()
    expect(screen.getByText(/opencode discovery works on macOS and Linux, but not Windows/i)).toBeInTheDocument()
    expect(screen.getByText(/Cursor credentials aren't discoverable yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/discover Cursor/i)).not.toBeInTheDocument()
  })

  test("keeps web sign-in and API keys usable while device login degrades honestly", () => {
    const onProviderConnect = vi.fn()
    render(() => (
      <AIConnectSurface
        localDiscovery={false}
        deviceLoginConfigured={false}
        request={vi.fn()}
        invalidateQueries={vi.fn()}
        onProviderConnect={onProviderConnect}
      />
    ))

    expect(screen.getByRole("heading", { name: "Provider sign-in" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Connect from terminal" })).toBeInTheDocument()
    expect(screen.getByText(/coming soon on this server/i)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Enter an API key" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "See OpenAI sign-in options" }))
    expect(onProviderConnect).toHaveBeenCalledWith("openai")
  })

  test("saves only checked discoveries and becomes connected only after verification", async () => {
    const stub = requests([
      Response.json({ discovery_id: "discovery-1", items: [
        { provider_id: "anthropic", kind: "oauth_token", label: "Claude", origin: "macOS Keychain" },
        { provider_id: "openai", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json" },
      ] }),
      Response.json({ ok: true }),
      Response.json({ credentials: [{ id: "cred-anthropic", provider_id: "anthropic" }] }),
      Response.json({ result: "ok" }),
    ])
    const onConnected = vi.fn()
    render(() => (
      <AIConnectSurface
        localDiscovery
        request={stub.request}
        invalidateQueries={vi.fn()}
        onConnected={onConnected}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "Detect credentials" }))
    expect(await screen.findByText("Claude")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: /Codex/ }))
    fireEvent.click(screen.getByRole("button", { name: "Save selected" }))

    expect(await screen.findByText("Connected and verified")).toBeInTheDocument()
    expect(JSON.parse(String(stub.calls[1].init?.body))).toEqual({
      discovery_id: "discovery-1",
      items: [{ provider_id: "anthropic", scope: "local" }],
    })
    expect(onConnected).toHaveBeenCalledWith([
      { credentialId: "cred-anthropic", providerId: "anthropic", result: "ok" },
    ])
  })

  test.each([
    ["auth_failed", "rejected"],
    ["no_billing", "billing"],
  ] as const)("shows an amber connected-not-working state for %s", async (result, copy) => {
    const stub = requests([
      Response.json({ credential: { id: "cred-1", provider_id: "anthropic" } }),
      Response.json({ result }),
    ])
    const onConnected = vi.fn()
    render(() => (
      <AIConnectSurface
        localDiscovery={false}
        request={stub.request}
        invalidateQueries={vi.fn()}
        onConnected={onConnected}
      />
    ))

    fireEvent.input(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-test" } })
    fireEvent.click(screen.getByRole("button", { name: "Save and verify" }))

    expect(await screen.findByText("Connected, not working")).toBeInTheDocument()
    expect(screen.getByText(new RegExp(copy, "i"))).toBeInTheDocument()
    expect(onConnected).not.toHaveBeenCalled()
  })

  test("invalidates shared credential and provider queries before reporting success", async () => {
    const stub = requests([
      Response.json({ credential: { id: "cred-1", provider_id: "anthropic" } }),
      Response.json({ result: "ok" }),
    ])
    const order: string[] = []
    render(() => (
      <AIConnectSurface
        localDiscovery={false}
        request={stub.request}
        invalidateQueries={async () => { order.push("invalidate") }}
        onConnected={() => { order.push("connected") }}
      />
    ))

    fireEvent.input(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-test" } })
    fireEvent.click(screen.getByRole("button", { name: "Save and verify" }))
    await waitFor(() => expect(order).toEqual(["invalidate", "connected"]))
  })

  test("emits funnel events at verified success and typed failure moments", async () => {
    const success = requests([
      Response.json({ credential: { id: "cred-1", provider_id: "anthropic" } }),
      Response.json({ result: "ok" }),
    ])
    const events: unknown[] = []
    const first = render(() => (
      <AIConnectSurface localDiscovery={false} request={success.request} invalidateQueries={vi.fn()} emit={(event) => events.push(event)} />
    ))
    fireEvent.input(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-test" } })
    fireEvent.click(screen.getByRole("button", { name: "Save and verify" }))
    await screen.findByText("Connected and verified")
    first.unmount()

    const failed = requests([
      Response.json({ credential: { id: "cred-2", provider_id: "anthropic" } }),
      Response.json({ result: "auth_failed" }),
    ])
    render(() => (
      <AIConnectSurface localDiscovery={false} request={failed.request} invalidateQueries={vi.fn()} emit={(event) => events.push(event)} />
    ))
    fireEvent.input(screen.getByLabelText("Anthropic API key"), { target: { value: "bad-key" } })
    fireEvent.click(screen.getByRole("button", { name: "Save and verify" }))
    await screen.findByText("Connected, not working")

    expect(events).toEqual([
      { name: "provider_connected", provider: "anthropic" },
      { name: "step_verify_failed", step: "ai", class: "auth_failed" },
    ])
  })
})
