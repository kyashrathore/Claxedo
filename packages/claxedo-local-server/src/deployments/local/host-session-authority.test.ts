import { afterEach, describe, expect, test, vi } from "vitest"
import { setUserHostedServing, stopUserHostedServing } from "@claxedo/host-serving/serving"
import {
  localHostRelayActor,
  localHostSessionAccessPolicy,
  resetLocalHostSessionAdoptions,
  setLocalHostEndpoints,
} from "./host-session-authority"

// The relay connection is not what this file is about, and dialling one would
// leave a reconnect loop behind every test.
vi.mock("@claxedo/workspace-runtime/relay", async (importOriginal) => ({
  ...await importOriginal<typeof import("@claxedo/workspace-runtime/relay")>(),
  hostTunnelPreOpenQueueFromEnv: () => ({}),
  startWorkspaceRelayHostTunnel: (options: { onEvent: (event: { type: string }) => void }) => {
    options.onEvent({ type: "connecting" })
    return { close: () => {}, updateRegistration: async () => {} }
  },
}))

const WS = "11111111-1111-4111-8111-111111111111"

function serve() {
  return setUserHostedServing(
    {
      hostId: "host_machine-1",
      relayUrl: "https://relay.claxedo.test",
      token: "host-tunnel-token",
      workspaceIds: [WS],
      expiresAt: Date.now() + 300_000,
    },
    { localBaseUrl: "http://127.0.0.1:2593", sessionAuthority: () => "managed-private" },
  )
}

function request(headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1:2593/workspaces/${WS}/session`, { headers })
}

afterEach(() => {
  stopUserHostedServing()
  setLocalHostEndpoints(undefined)
})

describe("the desktop's relay actor resolver", () => {
  test("resolves nothing while this machine is not serving, whatever the request carries", async () => {
    await expect(localHostRelayActor(request({ authorization: "Bearer anything" }), WS)).resolves.toBeUndefined()
  })

  test("resolves nothing for a request with no bearer, and nothing for a bearer the relay did not sign", async () => {
    await serve()

    await expect(localHostRelayActor(request(), WS)).resolves.toBeUndefined()
    // A control-plane JWT is what a signed browser on this machine's own
    // loopback presents; it is not issued by the relay, so it leaves that
    // caller the machine's own user rather than promoting it to a member.
    await expect(localHostRelayActor(request({ authorization: "Bearer control-plane-jwt" }), WS))
      .resolves.toBeUndefined()
  })
})

describe("the desktop's session access policy", () => {
  test("declares managed-private so the control plane mints scoped streams for this machine", () => {
    expect(localHostSessionAccessPolicy.sessionAuthority).toBe("managed-private")
  })

  test("admits an unstamped caller as the local owner and fails a stamped one closed until the authority address lands", async () => {
    const owner = await localHostSessionAccessPolicy.authorize({
      operation: "session_meta_read",
      sessionId: "ses_1",
    })
    const relayedMember = await localHostSessionAccessPolicy.authorize({
      operation: "session_meta_read",
      sessionId: "ses_1",
      credential: "Bearer rht",
      actor: { actorId: "actor_member", actorKind: "human" },
      authority: { managed: true, workspaceId: WS, orgId: "org_1", role: "editor" },
    })

    expect(owner).toEqual({ allowed: true })
    expect(relayedMember).toMatchObject({ allowed: false, code: "session_authority_unavailable" })
  })
})

describe("the desktop's claim on a refused session", () => {
  afterEach(() => {
    resetLocalHostSessionAdoptions()
  })

  /** The control plane's address is known, and every call it makes is recorded. */
  async function authority(answer: (action: string) => Response) {
    const calls: string[] = []
    const previous = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { action?: string }
      calls.push(String(body.action))
      return answer(String(body.action))
    }) as typeof globalThis.fetch
    setLocalHostEndpoints({ sessionAuthorityUrl: "http://127.0.0.1:1/session-authorize" })
    return { calls, restore: () => { globalThis.fetch = previous } }
  }

  const refused = () => Response.json({ error: { code: "workspace_authorization_denied" } }, { status: 403 })

  function relayedRead(role: "owner" | "editor") {
    return localHostSessionAccessPolicy.authorize({
      operation: "session_meta_read",
      sessionId: "ses_not_here",
      credential: "Bearer rht",
      actor: { actorId: "actor_1", actorKind: "human" },
      authority: { managed: true, workspaceId: WS, orgId: "org_1", role },
    })
  }

  test("asks nothing more for a caller the relay did not name as the workspace's owner", async () => {
    const { calls, restore } = await authority(refused)
    try {
      await expect(relayedRead("editor")).resolves.toMatchObject({ allowed: false, status: 403 })
      expect(calls).toEqual(["read"])
    } finally {
      restore()
    }
  })

  test("asks nothing more for an owner when no runtime in this process holds the session", async () => {
    const { calls, restore } = await authority(refused)
    try {
      await expect(relayedRead("owner")).resolves.toMatchObject({ allowed: false, status: 403 })
      expect(calls).toEqual(["read"])
    } finally {
      restore()
    }
  })
})
