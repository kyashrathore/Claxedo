import { Hono } from "hono"
import { expect, test } from "vitest"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { stampRequestPeerAddress } from "@claxedo/server-core/platform/http/peer-address"
import { operatorOwnsWorkspace, selfHostedOperatorGuard } from "./operator"

test("unsigned machine control requires the real loopback peer", async () => {
  const app = new Hono().use(selfHostedOperatorGuard(localOnlyAuthAdapter())).get("/", (c) => c.text("allowed"))
  for (const [peer, status] of [["127.0.0.1", 200], ["203.0.113.10", 403]] as const) {
    const request = new Request("http://127.0.0.1/")
    stampRequestPeerAddress(request, { incoming: { socket: { remoteAddress: peer } } })
    expect((await app.request(request)).status).toBe(status)
  }
})

test("misconfigured authentication never falls through to local operator access", async () => {
  const app = new Hono().use(selfHostedOperatorGuard({
    config: { enabled: false, mode: "misconfigured", reason: "missing issuer" },
  })).get("/", (c) => c.text("allowed"))
  expect((await app.request("http://127.0.0.1/")).status).toBe(503)
})

test("a workspace is an operator's only when the authority names an operator as its owner", async () => {
  const owners: Record<string, { userId: string; actorId: string; orgId: string; projectId: string }> = {
    "ws-operator": { userId: "subject-operator", actorId: "a1", orgId: "org", projectId: "p1" },
    "ws-member": { userId: "subject-member", actorId: "a2", orgId: "org", projectId: "p2" },
  }
  const authority = { resolveWorkspaceOwner: async (workspaceId: string) => owners[workspaceId] }
  const subjects = new Set(["subject-operator"])
  const owns = (workspaceId: string, extra: Partial<Parameters<typeof operatorOwnsWorkspace>[0]> = {}) =>
    operatorOwnsWorkspace({ signed: true, workspaceId, authority, subjects, ...extra })
  expect(await owns("ws-operator")).toBe(true)
  expect(await owns("ws-member")).toBe(false)
  expect(await owns("ws-unknown")).toBe(false)
  expect(await owns("ws-operator", { authority: { resolveWorkspaceOwner: () => Promise.reject(new Error("store down")) } })).toBe(false)
  expect(await owns("ws-operator", { authority: {} })).toBe(false)
  expect(await owns("ws-member", { signed: false })).toBe(true)
})
