import { Hono } from "hono"
import { expect, test } from "vitest"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { stampRequestPeerAddress } from "@claxedo/server-core/platform/http/peer-address"
import { selfHostedOperatorGuard } from "./operator"

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
