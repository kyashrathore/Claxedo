import { describe, expect, test } from "vitest"
import {
  LiveSyncRoom,
  connectLiveSyncRoom,
  liveSyncRoomName,
  liveSyncRoomNameForPrincipal,
  nudgeLiveSyncRoom,
  roomPrincipalFromHeaders,
  type LiveSyncRoomNamespace,
  type LiveSyncRoomState,
  type LiveSyncSocket,
  type LiveSyncSubscriber,
} from "./live-sync-room"
import type { ClaxedoEvent } from "./bus"
import type { ControlPlaneAuthContext } from "./control-plane/auth"

// A faithful in-memory emulation of the Cloudflare DO namespace contract:
// `idFromName(name)` is deterministic and `get(id)` returns a stub bound to the
// SINGLE instance for that name. Different names → different instances → the
// exact isolation the real runtime provides. This lets us prove the fan-out
// core + name-routing without the live Workers runtime.
function createFakeNamespace(): LiveSyncRoomNamespace & { instances: Map<string, LiveSyncRoom> } {
  const instances = new Map<string, LiveSyncRoom>()
  return {
    instances,
    idFromName(name: string) {
      return name
    },
    get(id: unknown) {
      const name = id as string
      let room = instances.get(name)
      if (!room) {
        room = new LiveSyncRoom({}, {})
        instances.set(name, room)
      }
      const instance = room
      return { fetch: (request: Request) => instance.fetch(request) }
    },
  }
}

class FakeSocket extends EventTarget implements LiveSyncSocket {
  peer?: FakeSocket
  attachment?: ReturnType<NonNullable<LiveSyncSocket["deserializeAttachment"]>>
  bufferedAmount = 0
  closed = false

  accept() {}

  send(data: string) {
    if (this.closed) throw new Error("socket closed")
    this.peer?.dispatchEvent(new MessageEvent("message", { data }))
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.dispatchEvent(new Event("close"))
    if (!this.peer || this.peer.closed) return
    this.peer.closed = true
    this.peer.dispatchEvent(new Event("close"))
  }

  serializeAttachment(attachment: NonNullable<FakeSocket["attachment"]>) {
    this.attachment = attachment
  }

  deserializeAttachment() {
    return this.attachment
  }
}

function fakePair() {
  const client = new FakeSocket()
  const server = new FakeSocket()
  client.peer = server
  server.peer = client
  return { client, server }
}

function createHibernatingNamespace() {
  const instances = new Map<string, LiveSyncRoom>()
  const states = new Map<string, LiveSyncRoomState & { sockets: FakeSocket[] }>()
  const room = (name: string) => {
    const current = instances.get(name)
    if (current) return current
    const state = states.get(name) ?? (() => {
      const sockets: FakeSocket[] = []
      return {
        sockets,
        acceptWebSocket(socket: LiveSyncSocket) {
          sockets.push(socket as FakeSocket)
        },
        getWebSockets() {
          return sockets.filter((socket) => !socket.closed)
        },
      }
    })()
    states.set(name, state)
    const next = new LiveSyncRoom(state, {
      createWebSocketPair: fakePair,
      upgradeResponse(client) {
        const response = new Response(null)
        Object.defineProperty(response, "webSocket", { value: client })
        return response
      },
    })
    instances.set(name, next)
    return next
  }
  return {
    instances,
    states,
    idFromName: (name: string) => name,
    get: (id: unknown) => ({ fetch: (request: Request) => room(id as string).fetch(request) }),
    evict(name: string) {
      instances.delete(name)
      return room(name)
    },
  } satisfies LiveSyncRoomNamespace & {
    instances: Map<string, LiveSyncRoom>
    states: Map<string, LiveSyncRoomState & { sockets: FakeSocket[] }>
    evict(name: string): LiveSyncRoom
  }
}

const signedAuth = (subject: string, clerkOrgId?: string): ControlPlaneAuthContext => ({
  mode: "signed",
  token: "t",
  user: { subject, tokenIdentifier: subject, issuer: "iss", ...(clerkOrgId ? { orgId: clerkOrgId } : {}) },
})

// A resolved subscriber: `orgId` is the AUTHORITY-INTERNAL org id
// (`authority.resolveOrgId` output), the namespace rooms are keyed with —
// deliberately DIFFERENT-looking from any Clerk `org_...` claim in these tests
// so a regression back to the claims namespace cannot pass by coincidence.
const subscriber = (subject: string, internalOrgId?: string): LiveSyncSubscriber => ({
  auth: signedAuth(subject),
  ...(internalOrgId ? { orgId: internalOrgId } : {}),
})

const workgraphChanged = (ownerUserId: string): ClaxedoEvent => ({
  type: "workgraph.changed",
  ownerUserId,
  ts: Date.now(),
})

const documentChanged = (orgId: string): ClaxedoEvent => ({
  type: "document.changed",
  documentId: "doc_1",
  orgId,
  projectId: "proj_1",
  ts: Date.now(),
})

// Read exactly one SSE `data:` frame (one enqueue = one full frame) and return
// its parsed JSON payload.
async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const decoder = new TextDecoder()
  const { value, done } = await reader.read()
  if (done || !value) throw new Error("stream ended before a frame arrived")
  const text = decoder.decode(value)
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n")
  return JSON.parse(data)
}

describe("LiveSyncRoom — fan-out core (W5.1)", () => {
  test("hibernatable sockets survive room reconstruction while the public response remains SSE", async () => {
    const namespace = createHibernatingNamespace()
    const response = await connectLiveSyncRoom(namespace, subscriber("alice", "org_internal_acme"), 60_000)
    const reader = response.body!.getReader()
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(await readFrame(reader)).toEqual({ type: "heartbeat" })
    expect(namespace.instances.get("org:org_internal_acme")!.size).toBe(1)

    const reconstructed = namespace.evict("org:org_internal_acme")
    const event = workgraphChanged("alice")
    expect(await nudgeLiveSyncRoom(namespace, "org:org_internal_acme", event)).toEqual({ delivered: 1, held: 1 })
    expect(await readFrame(reader)).toEqual(event)
    expect(reconstructed.size).toBe(1)
    await reader.cancel()
  })

  test("rejects structurally invalid nudge JSON", async () => {
    const room = new LiveSyncRoom({}, {})
    const response = await room.fetch(new Request("https://live-sync-room.internal/nudge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }))
    expect(response.status).toBe(400)
  })

  test("reauthorizes held streams and closes them when the bearer is no longer valid", async () => {
    const namespace = createHibernatingNamespace()
    const response = await connectLiveSyncRoom(
      namespace,
      subscriber("alice", "org_internal_acme"),
      1,
      async () => {
        throw new Error("bearer expired")
      },
    )
    const reader = response.body!.getReader()
    expect(await readFrame(reader)).toEqual({ type: "heartbeat" })
    await expect(reader.read()).rejects.toThrow("bearer expired")
    expect(namespace.instances.get("org:org_internal_acme")!.size).toBe(0)
  })

  test("closes a stalled SSE bridge before its queue can grow without bound", async () => {
    const namespace = createHibernatingNamespace()
    const response = await connectLiveSyncRoom(namespace, subscriber("alice", "org_internal_acme"), 60_000)
    const reader = response.body!.getReader()
    for (const _ of Array.from({ length: 40 })) {
      await nudgeLiveSyncRoom(namespace, "org:org_internal_acme", workgraphChanged("alice"))
    }
    await expect(reader.read()).rejects.toThrow("too slow")
    expect(namespace.instances.get("org:org_internal_acme")!.size).toBe(0)
  })

  test("N connections held by one room all receive a nudge; another owner's room does not", async () => {
    const namespace = createFakeNamespace()
    const alice = subscriber("alice", "org_internal_acme")
    const bob = subscriber("bob", "org_internal_beta")

    // Alice opens 3 connections; all land in the SAME room (org:org_internal_acme).
    const aliceConns = await Promise.all([
      connectLiveSyncRoom(namespace, alice, 60_000),
      connectLiveSyncRoom(namespace, alice, 60_000),
      connectLiveSyncRoom(namespace, alice, 60_000),
    ])
    expect(liveSyncRoomName(alice)).toBe("org:org_internal_acme")
    expect(namespace.instances.get("org:org_internal_acme")!.size).toBe(3)

    const aliceReaders = aliceConns.map((res) => {
      expect(res.headers.get("Content-Type")).toBe("text/event-stream")
      return res.body!.getReader()
    })
    // Each connection first receives the initial heartbeat hello.
    for (const reader of aliceReaders) {
      expect(await readFrame(reader)).toEqual({ type: "heartbeat" })
    }

    // Bob opens 1 connection in a DIFFERENT room (org:org_internal_beta).
    const bobRes = await connectLiveSyncRoom(namespace, bob, 60_000)
    const bobReader = bobRes.body!.getReader()
    expect(await readFrame(bobReader)).toEqual({ type: "heartbeat" })

    // Nudge Alice's room. All 3 of Alice's connections get it.
    const event = workgraphChanged("alice")
    const result = await nudgeLiveSyncRoom(namespace, "org:org_internal_acme", event)
    expect(result).toEqual({ delivered: 3, held: 3 })
    for (const reader of aliceReaders) {
      expect(await readFrame(reader)).toEqual(event)
    }

    // Bob's room is untouched by Alice's nudge: nudging org:org_internal_beta
    // with a workgraph event for bob delivers to bob only, never to Alice.
    const bobEvent = workgraphChanged("bob")
    const bobResult = await nudgeLiveSyncRoom(namespace, "org:org_internal_beta", bobEvent)
    expect(bobResult).toEqual({ delivered: 1, held: 1 })
    expect(await readFrame(bobReader)).toEqual(bobEvent)
  })

  test("per-connection eventVisibleTo filters an owner-scoped event to the wrong subject", async () => {
    const namespace = createFakeNamespace()
    // Two DIFFERENT users in the SAME org share the org room.
    const alice = subscriber("alice", "org_internal_acme")
    const carol = subscriber("carol", "org_internal_acme")
    expect(liveSyncRoomName(alice)).toBe("org:org_internal_acme")
    expect(liveSyncRoomName(carol)).toBe("org:org_internal_acme")

    const aliceRes = await connectLiveSyncRoom(namespace, alice, 60_000)
    const carolRes = await connectLiveSyncRoom(namespace, carol, 60_000)
    const aliceReader = aliceRes.body!.getReader()
    const carolReader = carolRes.body!.getReader()
    expect(await readFrame(aliceReader)).toEqual({ type: "heartbeat" })
    expect(await readFrame(carolReader)).toEqual({ type: "heartbeat" })

    // A workgraph.changed for alice is owner-scoped: only alice's connection
    // receives it even though both share the org room.
    const event = workgraphChanged("alice")
    const result = await nudgeLiveSyncRoom(namespace, "org:org_internal_acme", event)
    expect(result).toEqual({ delivered: 1, held: 2 })
    expect(await readFrame(aliceReader)).toEqual(event)
  })

  test("an org-scoped document.changed fans to every member of the org room", async () => {
    const namespace = createFakeNamespace()
    const alice = subscriber("alice", "org_internal_acme")
    const carol = subscriber("carol", "org_internal_acme")
    const aliceRes = await connectLiveSyncRoom(namespace, alice, 60_000)
    const carolRes = await connectLiveSyncRoom(namespace, carol, 60_000)
    const aliceReader = aliceRes.body!.getReader()
    const carolReader = carolRes.body!.getReader()
    expect(await readFrame(aliceReader)).toEqual({ type: "heartbeat" })
    expect(await readFrame(carolReader)).toEqual({ type: "heartbeat" })

    // The event's orgId is the authority-internal id — the same value the
    // subscribers resolved at connect — so BOTH members receive the frame.
    const event = documentChanged("org_internal_acme")
    const result = await nudgeLiveSyncRoom(
      namespace,
      liveSyncRoomNameForPrincipal({ orgId: "org_internal_acme" }),
      event,
    )
    expect(result).toEqual({ delivered: 2, held: 2 })
    expect(await readFrame(aliceReader)).toEqual(event)
    expect(await readFrame(carolReader)).toEqual(event)
  })

  test("cancelling the client stream drops the held connection", async () => {
    const room = new LiveSyncRoom({}, {})
    const res = await room.fetch(
      new Request("https://live-sync-room.internal/connect", {
        headers: { "x-livesync-mode": "signed", "x-livesync-subject": "alice", "x-livesync-org": "org_internal_acme" },
      }),
    )
    expect(room.size).toBe(1)
    await res.body!.cancel()
    expect(room.size).toBe(0)
  })

  test("roomPrincipalFromHeaders / liveSyncRoomName cover signed-no-org and unsigned-local", () => {
    expect(liveSyncRoomName(subscriber("dave"))).toBe("owner:dave")
    expect(liveSyncRoomName({ auth: { mode: "unsigned-local", reason: "x" } })).toBe("owner:local")

    const signedPrincipal = roomPrincipalFromHeaders(
      new Headers({ "x-livesync-mode": "signed", "x-livesync-subject": "dave" }),
    )
    expect(signedPrincipal).toEqual({ mode: "signed", subject: "dave" })
    const orgPrincipal = roomPrincipalFromHeaders(
      new Headers({ "x-livesync-mode": "signed", "x-livesync-subject": "dave", "x-livesync-org": "org_internal_acme" }),
    )
    expect(orgPrincipal).toEqual({ mode: "signed", subject: "dave", orgId: "org_internal_acme" })
    const localPrincipal = roomPrincipalFromHeaders(new Headers({ "x-livesync-mode": "unsigned-local" }))
    expect(localPrincipal).toEqual({ mode: "unsigned-local" })
  })

  test("the subscriber's room is keyed by the RESOLVED internal org id, never the Clerk claim", () => {
    // The regression this pins: the auth context carries the Clerk `org_...`
    // claim, a DISJOINT namespace from the internal org id every publisher
    // stamps. The room name must come from the resolved internal id; a Clerk
    // claim on the auth must not leak into the derivation.
    const withClerkClaim: LiveSyncSubscriber = {
      auth: signedAuth("alice", "org_2clerkabc"),
      orgId: "org_internal_acme",
    }
    expect(liveSyncRoomName(withClerkClaim)).toBe("org:org_internal_acme")

    // No resolved internal id (no authority composed) → subject-keyed owner
    // room, even when the Clerk claim is present.
    expect(liveSyncRoomName({ auth: signedAuth("alice", "org_2clerkabc") })).toBe("owner:alice")
  })
})

describe("live-sync room-name derivation — publisher/subscriber agreement (W5.4)", () => {
  test("publisher helper agrees with the subscriber for a signed caller WITHOUT a resolved org", () => {
    // The regression this pins: a publisher hand-composing `org:${orgId}` for a
    // caller whose SSE stream is held in `owner:<subject>` strands the frame in
    // a room nobody joined. Publisher-side derivation must match the room the
    // subscriber (`connectLiveSyncRoom` via `liveSyncRoomName`) is held in.
    expect(liveSyncRoomNameForPrincipal({ ownerUserId: "dave" })).toBe("owner:dave")
    expect(liveSyncRoomNameForPrincipal({ ownerUserId: "dave" })).toBe(liveSyncRoomName(subscriber("dave")))
  })

  test("publisher helper agrees with the subscriber for a caller WITH a resolved org", () => {
    // Both sides carry the AUTHORITY-INTERNAL org id: the publisher from its
    // tenant identity (runtime-token claims / settlement tenant / event stamp),
    // the subscriber from `authority.resolveOrgId` at connect.
    expect(liveSyncRoomNameForPrincipal({ ownerUserId: "alice", orgId: "org_internal_acme" })).toBe(
      "org:org_internal_acme",
    )
    expect(liveSyncRoomNameForPrincipal({ ownerUserId: "alice", orgId: "org_internal_acme" })).toBe(
      liveSyncRoomName(subscriber("alice", "org_internal_acme")),
    )
  })

  test("a helper-derived nudge reaches the held stream of a signed-no-org subscriber", async () => {
    const namespace = createFakeNamespace()
    const response = await connectLiveSyncRoom(namespace, subscriber("dave"), 60_000)
    const reader = response.body!.getReader()
    expect(await readFrame(reader)).toEqual({ type: "heartbeat" })

    const event = workgraphChanged("dave")
    const result = await nudgeLiveSyncRoom(namespace, liveSyncRoomNameForPrincipal({ ownerUserId: "dave" }), event)
    expect(result).toEqual({ delivered: 1, held: 1 })
    expect(await readFrame(reader)).toEqual(event)
    await reader.cancel()
  })

  test("the helper refuses identity material that cannot name a real room", () => {
    expect(() => liveSyncRoomNameForPrincipal({})).toThrow("owner subject is invalid")
    expect(() => liveSyncRoomNameForPrincipal({ ownerUserId: "" })).toThrow("owner subject is invalid")
    expect(() => liveSyncRoomNameForPrincipal({ ownerUserId: "undefined" })).toThrow("owner subject is invalid")
    expect(() => liveSyncRoomNameForPrincipal({ ownerUserId: "dave", orgId: "" })).toThrow("org id is invalid")
    expect(() => liveSyncRoomNameForPrincipal({ ownerUserId: "dave", orgId: "undefined" })).toThrow("org id is invalid")
  })

  test("nudgeLiveSyncRoom rejects hand-composed room names with a broken segment before touching the namespace", async () => {
    const gets: unknown[] = []
    const namespace: LiveSyncRoomNamespace = {
      idFromName: (name: string) => name,
      get(id) {
        gets.push(id)
        return { fetch: async () => Response.json({ delivered: 0, held: 0 }) }
      },
    }
    for (const roomName of ["org:undefined", "org:null", "org:", "org: ", "owner:", "workspace:w1", ""]) {
      await expect(nudgeLiveSyncRoom(namespace, roomName, workgraphChanged("dave"))).rejects.toThrow(
        "live-sync room name is invalid",
      )
    }
    expect(gets).toEqual([])

    // Well-formed names still pass through to the namespace untouched.
    await expect(nudgeLiveSyncRoom(namespace, "owner:dave", workgraphChanged("dave"))).resolves.toEqual({
      delivered: 0,
      held: 0,
    })
    expect(gets).toEqual(["owner:dave"])
  })
})
