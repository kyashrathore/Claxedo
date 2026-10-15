import { describe, expect, test } from "bun:test"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { RuntimeAccessTokenClaims } from "./auth"
import type { AuthorizedWorkspaceRelayRequest } from "./server"
import { forwardSessionHostHttp, type SessionHostNamespace } from "./session-host-forwarding"

const ROOT = "ses_root"

function authorized(): AuthorizedWorkspaceRelayRequest {
  return {
    claims: {} as RuntimeAccessTokenClaims,
    target: { workspaceId: "ws_1", hostId: sessionHostId(ROOT), baseUrl: "https://unused.invalid", backing: "durable-object" },
    relayHostToken: "relay-host-token",
    path: `/session/${ROOT}`,
  }
}

function recordingNamespace() {
  const addressed: { name: string; options: unknown }[] = []
  const namespace: SessionHostNamespace = {
    getByName: (name, options) => {
      addressed.push({ name, options })
      return { fetch: async () => new Response("ok", { status: 201 }) }
    },
  }
  return { namespace, addressed }
}

describe("forwardSessionHostHttp", () => {
  test("places a session's Durable Object in eastern North America whoever opens it first", async () => {
    const { namespace, addressed } = recordingNamespace()
    const request = new Request(`https://relay.invalid/workspaces/ws_1/session/${ROOT}?nativeHarness=pi`, {
      method: "POST",
      headers: { "cf-ipcountry": "IN" },
      body: "{}",
    })

    const response = await forwardSessionHostHttp(namespace, request, authorized())

    expect(response.status).toBe(201)
    expect(addressed).toEqual([{ name: ROOT, options: { locationHint: "enam" } }])
  })
})
