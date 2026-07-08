import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { NetworkPolicySettings } from "./network-policy-settings"

const calls: Array<{ method: string; url: string; body?: unknown }> = []
let workspaceRole: "owner" | "admin" | "editor" | "viewer" = "admin"

async function requestBody(request: Request) {
  const text = await request.clone().text()
  return text ? JSON.parse(text) as unknown : undefined
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit) {
  const request = input instanceof Request ? input : new Request(String(input), init)
  const url = new URL(request.url)
  calls.push({ method: request.method, url: request.url, body: await requestBody(request) })

  if (url.pathname === "/api/workspace/ws_1/connection") {
    return Response.json({
      access: "cloud",
      backing: "cloud-vm",
      workspaceId: "ws_1",
      role: workspaceRole,
      relayUrl: "https://relay.example.test",
      runtimeAccessToken: "runtime-token",
      tokenExpiresAt: Date.now() + 120_000,
    })
  }
  if (url.pathname === "/api/claxedo/network-policy/groups") {
    return Response.json({ groups: { npm: ["registry.npmjs.org"] } })
  }
  if (url.pathname === "/api/claxedo/network-policy" && request.method === "GET") {
    return Response.json({
      policies: [{
        id: "policy_1",
        target: "api.example.com",
        kind: "host",
        constraints: {},
      }],
    })
  }
  if (url.pathname === "/api/claxedo/network-policy" && request.method === "POST") {
    return Response.json({ policy: { id: "policy_2" } }, { status: 201 })
  }
  if (url.pathname === "/api/claxedo/network-policy/policy_1" && request.method === "DELETE") {
    return Response.json({ deleted: true })
  }
  throw new Error(`unexpected request: ${request.method} ${request.url}`)
}

vi.mock("@opencode-ai/claxedo-app", () => ({
  usePlatform: () => ({ fetch: fakeFetch }),
}))

vi.mock("@/context/global-sdk", () => ({
  useGlobalSDK: () => ({ url: "http://127.0.0.1:3001" }),
}))

afterEach(() => {
  cleanup()
  calls.length = 0
  workspaceRole = "admin"
})

describe("NetworkPolicySettings role gate", () => {
  test("disables workspace policy writes when the backend role is not admin-capable", async () => {
    workspaceRole = "viewer"
    render(() => <NetworkPolicySettings workspaceId="ws_1" />)

    await waitFor(() => expect(screen.getByText("api.example.com")).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText("Only workspace admins and owners can edit network policy.")).toBeInTheDocument())

    fireEvent.input(screen.getByPlaceholderText("api.example.com"), {
      target: { value: "api2.example.com" },
    })
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Remove api.example.com" })).toBeDisabled()
    expect(calls.some((call) => call.method === "POST" || call.method === "DELETE")).toBe(false)
  })

  test("allows workspace policy writes for admin roles", async () => {
    workspaceRole = "admin"
    render(() => <NetworkPolicySettings workspaceId="ws_1" />)

    await waitFor(() => expect(screen.getByText("api.example.com")).toBeInTheDocument())
    fireEvent.input(screen.getByPlaceholderText("api.example.com"), {
      target: { value: "api2.example.com" },
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => expect(calls.some((call) =>
      call.method === "POST" &&
      new URL(call.url).pathname === "/api/claxedo/network-policy" &&
      (call.body as { workspace_id?: string } | undefined)?.workspace_id === "ws_1"
    )).toBe(true))
  })
})
