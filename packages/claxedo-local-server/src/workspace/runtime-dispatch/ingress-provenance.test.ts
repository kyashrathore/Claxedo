import { describe, expect, test } from "vitest"
import { resolveIngressProvenance, type IngressActor } from "./ingress-provenance"

const ACTOR: IngressActor = {
  actorId: "actor_1",
  actorKind: "human",
  actorPublicId: "usr_1",
  actorName: "Alice",
  orgId: "org_1",
  role: "editor",
}

/** What the tunnel hands the daemon: the relay's bearer and its own marker, on loopback. */
function request(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:2593/workspaces/ws_1/session", { headers })
}

const relayed = { authorization: "Bearer rht", "x-forwarded-by": "workspace-relay" }

describe("ingress provenance", () => {
  test("a verified relay actor is relay-replayed, and the stamp carries its display identity", async () => {
    const provenance = await resolveIngressProvenance(request(relayed), "ws_1", {
      resolveRelayActor: async () => ACTOR,
    })

    expect(provenance.kind).toBe("relay-replayed")
    if (provenance.kind !== "relay-replayed") return
    expect(provenance.stamp).toMatchObject({
      principal_kind: "user",
      actor_id: "actor_1",
      actor_public_id: "usr_1",
      actor_name: "Alice",
      org_id: "org_1",
      workspace_id: "ws_1",
      role: "editor",
    })
  })

  test("a request carrying the relay's marker whose actor does not verify is refused, never read as local", async () => {
    // The relay replays onto this machine's own loopback with the proxy
    // headers stripped, so every address check says local. Reading an
    // unverifiable one as the owner is the whole hole this closes.
    const provenance = await resolveIngressProvenance(request(relayed), "ws_1", {
      resolveRelayActor: async () => undefined,
      verifyRelayIngress: true,
    })

    expect(provenance.kind).toBe("rejected")
    if (provenance.kind !== "rejected") return
    expect(provenance.response.status).toBe(403)
    await expect(provenance.response.json()).resolves
      .toMatchObject({ error: { code: "relay_actor_unverified" } })
  })

  test("a composition that serves one kind of caller dispatches the same request unstamped", async () => {
    // A host whose runtimes admit every caller alike gains nothing from the
    // refusal and would lose the relayed traffic it serves today.
    const provenance = await resolveIngressProvenance(request(relayed), "ws_1", {
      resolveRelayActor: async () => undefined,
    })

    expect(provenance.kind).toBe("loopback-direct")
  })

  test("a loopback request with no relay marks is the machine's own user, bearer or not", async () => {
    const bare = await resolveIngressProvenance(request(), "ws_1", {
      resolveRelayActor: async () => undefined,
      verifyRelayIngress: true,
    })
    const signedBrowser = await resolveIngressProvenance(
      request({ authorization: "Bearer control-plane-jwt" }),
      "ws_1",
      { resolveRelayActor: async () => undefined, verifyRelayIngress: true },
    )

    expect(bare.kind).toBe("loopback-direct")
    expect(signedBrowser.kind).toBe("loopback-direct")
  })

  test("a request that is not loopback is refused even with no relay marks", async () => {
    const provenance = await resolveIngressProvenance(
      new Request("http://claxedo.example/workspaces/ws_1/session"),
      "ws_1",
      { verifyRelayIngress: true },
    )

    expect(provenance.kind).toBe("rejected")
    if (provenance.kind !== "rejected") return
    await expect(provenance.response.json()).resolves
      .toMatchObject({ error: { code: "workspace_request_not_loopback" } })
  })

  test("a deployment with no local owner refuses every unstamped request, including a loopback one", async () => {
    const provenance = await resolveIngressProvenance(request(), "ws_1", { requireRelayActor: true })

    expect(provenance.kind).toBe("rejected")
    if (provenance.kind !== "rejected") return
    expect(provenance.response.status).toBe(403)
  })
})
