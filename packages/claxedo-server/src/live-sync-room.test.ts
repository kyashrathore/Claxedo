import { describe, expect, test } from "vitest"
import {
  LiveSyncRoom,
  connectLiveSyncRoom,
  liveSyncRoomName,
  nudgeLiveSyncRoom,
  roomAuthFromHeaders,
  type LiveSyncRoomNamespace,
  type LiveSyncRoomState,
  type LiveSyncSocket,
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

const signed = (subject: string, orgId?: string): ControlPlaneAuthContext => ({
  mode: "signed",
  token: "t",
  user: { subject, tokenIdentifier: subject, issuer: "iss", ...(orgId ? { orgId } : {}) },
})

const workgraphChanged = (ownerUserId: string): ClaxedoEvent => ({
  type: "workgraph.changed",
  ownerUserId,
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
    const response = await connectLiveSyncRoom(namespace, signed("alice", "acme"), 60_000)
    const reader = response.body!.getReader()
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(await readFrame(reader)).toEqual({ type: "heartbeat" })
    expect(namespace.instances.get("org:acme")!.size).toBe(1)

    const reconstructed = namespace.evict("org:acme")
    const event = workgraphChanged("alice")
    expect(await nudgeLiveSyncRoom(namespace, "org:acme", event)).toEqual({ delivered: 1, held: 1 })
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
      signed("alice", "acme"),
      1,
      async () => {
        throw new Error("bearer expired")
      },
    )
    const reader = response.body!.getReader()
    expect(await readFrame(reader)).toEqual({ type: "heartbeat" })
    await expect(reader.read()).rejects.toThrow("bearer expired")
    expect(namespace.instances.get("org:acme")!.size).toBe(0)
  })

  test("closes a stalled SSE bridge before its queue can grow without bound", async () => {
    const namespace = createHibernatingNamespace()
    const response = await connectLiveSyncRoom(namespace, signed("alice", "acme"), 60_000)
    const reader = response.body!.getReader()
    for (const _ of Array.from({ length: 40 })) {
      await nudgeLiveSyncRoom(namespace, "org:acme", workgraphChanged("alice"))
    }
    await expect(reader.read()).rejects.toThrow("too slow")
    expect(namespace.instances.get("org:acme")!.size).toBe(0)
  })

  test("N connections held by one room all receive a nudge; another owner's room does not", async () => {
    const namespace = createFakeNamespace()
    const alice = signed("alice", "acme")
    const bob = signed("bob", "beta")

    // Alice opens 3 connections; all land in the SAME room (org:acme).
    const aliceConns = await Promise.all([
      connectLiveSyncRoom(namespace, alice, 60_000),
      connectLiveSyncRoom(namespace, alice, 60_000),
      connectLiveSyncRoom(namespace, alice, 60_000),
    ])
    expect(liveSyncRoomName(alice)).toBe("org:acme")
    expect(namespace.instances.get("org:acme")!.size).toBe(3)

    const aliceReaders = aliceConns.map((res) => {
      expect(res.headers.get("Content-Type")).toBe("text/event-stream")
      return res.body!.getReader()
    })
    // Each connection first receives the initial heartbeat hello.
    for (const reader of aliceReaders) {
      expect(await readFrame(reader)).toEqual({ type: "heartbeat" })
    }

    // Bob opens 1 connection in a DIFFERENT room (org:beta).
    const bobRes = await connectLiveSyncRoom(namespace, bob, 60_000)
    const bobReader = bobRes.body!.getReader()
    expect(await readFrame(bobReader)).toEqual({ type: "heartbeat" })

    // Nudge Alice's room. All 3 of Alice's connections get it.
    const event = workgraphChanged("alice")
    const result = await nudgeLiveSyncRoom(namespace, "org:acme", event)
    expect(result).toEqual({ delivered: 3, held: 3 })
    for (const reader of aliceReaders) {
      expect(await readFrame(reader)).toEqual(event)
    }

    // Bob's room is untouched by Alice's nudge: nudging org:beta with a
    // workgraph event for bob delivers to bob only, never to Alice.
    const bobEvent = workgraphChanged("bob")
    const bobResult = await nudgeLiveSyncRoom(namespace, "org:beta", bobEvent)
    expect(bobResult).toEqual({ delivered: 1, held: 1 })
    expect(await readFrame(bobReader)).toEqual(bobEvent)
  })

  test("per-connection eventVisibleTo filters an owner-scoped event to the wrong subject", async () => {
    const namespace = createFakeNamespace()
    // Two DIFFERENT users in the SAME org share the org room.
    const alice = signed("alice", "acme")
    const carol = signed("carol", "acme")
    expect(liveSyncRoomName(alice)).toBe("org:acme")
    expect(liveSyncRoomName(carol)).toBe("org:acme")

    const aliceRes = await connectLiveSyncRoom(namespace, alice, 60_000)
    const carolRes = await connectLiveSyncRoom(namespace, carol, 60_000)
    const aliceReader = aliceRes.body!.getReader()
    const carolReader = carolRes.body!.getReader()
    expect(await readFrame(aliceReader)).toEqual({ type: "heartbeat" })
    expect(await readFrame(carolReader)).toEqual({ type: "heartbeat" })

    // A workgraph.changed for alice is owner-scoped: only alice's connection
    // receives it even though both share the org room.
    const event = workgraphChanged("alice")
    const result = await nudgeLiveSyncRoom(namespace, "org:acme", event)
    expect(result).toEqual({ delivered: 1, held: 2 })
    expect(await readFrame(aliceReader)).toEqual(event)
  })

  test("cancelling the client stream drops the held connection", async () => {
    const room = new LiveSyncRoom({}, {})
    const res = await room.fetch(
      new Request("https://live-sync-room.internal/connect", {
        headers: { "x-livesync-mode": "signed", "x-livesync-subject": "alice", "x-livesync-org": "acme" },
      }),
    )
    expect(room.size).toBe(1)
    await res.body!.cancel()
    expect(room.size).toBe(0)
  })

  test("roomAuthFromHeaders / liveSyncRoomName cover signed-no-org and unsigned-local", () => {
    expect(liveSyncRoomName(signed("dave"))).toBe("owner:dave")
    expect(liveSyncRoomName({ mode: "unsigned-local", reason: "x" })).toBe("owner:local")

    const signedAuth = roomAuthFromHeaders(
      new Headers({ "x-livesync-mode": "signed", "x-livesync-subject": "dave" }),
    )
    expect(signedAuth).toEqual({
      mode: "signed",
      token: "",
      user: { subject: "dave", tokenIdentifier: "dave", issuer: "" },
    })
    const localAuth = roomAuthFromHeaders(new Headers({ "x-livesync-mode": "unsigned-local" }))
    expect(localAuth.mode).toBe("unsigned-local")
  })
})
