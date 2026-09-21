import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Pty } from "./index"
import {
  authorizePtyAttach,
  createAuthorizedPtyConnection,
  ptyStreamAccess,
  type PtyStreamAccess,
  type PtyStreamAdmission,
  type PtyStreamSocket,
} from "./authorized-connection"
import type { SessionAccessPolicy } from "../session-access-policy"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"

const info: Pty.Info = {
  id: "pty_1",
  sessionId: "session_1",
  title: "Terminal",
  command: "/bin/sh",
  args: [],
  cwd: "/workspace",
  status: "running",
  pid: 1,
}

function identity(
  role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"] = "editor",
  actorId = "actor_member",
): NonNullable<RelayHostAuthContext["relayHostAuth"]> {
  return {
    principal_kind: "user",
    actor_id: actorId,
    actor_kind: "human",
    actor_public_id: `user_${actorId}`,
    actor_name: "Member",
    org_id: "org_1",
    workspace_id: "ws_1",
    role,
  }
}

function relayed(role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"] = "editor"): PtyStreamAccess {
  return ptyStreamAccess({
    identity: identity(role),
    authorization: "Bearer relay-token",
    method: "GET",
    path: "/pty_1/connect",
  })
}

const local: PtyStreamAccess = ptyStreamAccess({ method: "GET", path: "/pty_1/connect" })

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("attach refuses an invalid read lease deadline (%s)", async (offset) => {
  const { policy } = authority({ leaseMs: offset })
  const result = await authorizePtyAttach({ policy, access: relayed(), info })
  expect(result).toMatchObject({ allowed: false, status: 503, code: "pty_stream_authority_unavailable" })
})

type StreamCall = { operation: string; lease?: string }

/**
 * The control plane, reduced to the two verdicts a terminal asks it for and
 * the lease lifetime it answers with. `read`/`write` are flipped per test to
 * stand for a grant being changed while a socket is open.
 */
function authority(options: {
  read?: boolean
  write?: boolean
  leaseMs?: number
  throws?: boolean
  omitStream?: boolean
} = {}) {
  const state = {
    read: options.read ?? true,
    write: options.write ?? true,
    leaseMs: options.leaseMs ?? 15_000,
    throws: options.throws ?? false,
    calls: [] as StreamCall[],
    authorizeCalls: [] as string[],
  }
  const denial = { allowed: false as const, status: 403 as const, code: "private_session", message: "Session is private" }
  const policy: SessionAccessPolicy = {
    sessionAuthority: "managed-private",
    authorizeSessionStartStatus: () => denial,
    authorizeSessionStart: () => denial,
    authorize: async (request) => {
      state.authorizeCalls.push(request.operation)
      if (state.throws) throw new Error("authority is down")
      return state.read ? { allowed: true } : denial
    },
    filterSessions: async (request) => request.sessionIds,
    authorizePrefix: async () => ({ allowed: true }),
  }
  if (!options.omitStream) {
    policy.authorizeStream = async (request, lease) => {
      state.calls.push({ operation: request.operation, ...(lease ? { lease } : {}) })
      if (state.throws) throw new Error("authority is down")
      const granted = request.operation === "pty_write" ? state.write && state.read : state.read
      return granted
        ? { allowed: true, lease: `${request.operation}-lease`, expiresAt: Date.now() + state.leaseMs }
        : denial
    }
  }
  return { state, policy }
}

function fakeSocket() {
  const sent: Array<string | Uint8Array | ArrayBuffer> = []
  const closes: Array<{ code?: number; reason?: string }> = []
  const socket: PtyStreamSocket & { sent: typeof sent; closes: typeof closes } = {
    readyState: 1,
    bufferedAmount: 0,
    send(data) {
      sent.push(data)
    },
    close(code, reason) {
      closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
    },
    sent,
    closes,
  }
  return socket
}

/** The PTY side of a connection: what it was handed to write to, and what was typed into it. */
function fakePty() {
  const typed: unknown[] = []
  let attached: PtyStreamSocket | undefined
  let disconnects = 0
  const get = spyOn(Pty, "get").mockReturnValue(info)
  const connect = spyOn(Pty, "connect").mockImplementation((_id, socket) => {
    attached = socket
    return {
      onMessage: (message: unknown) => {
        typed.push(message)
      },
      onClose: () => {
        disconnects += 1
      },
    }
  })
  return {
    typed,
    get attached() {
      return attached
    },
    get disconnects() {
      return disconnects
    },
    get connected() {
      return connect.mock.calls.length
    },
    restore: () => {
      get.mockRestore()
      connect.mockRestore()
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const cleanup: Array<() => void> = []

afterEach(() => {
  for (const restore of cleanup.splice(0)) restore()
})

function pty() {
  const handle = fakePty()
  cleanup.push(handle.restore)
  return handle
}

function refusalOf(admission: Awaited<ReturnType<typeof authorizePtyAttach>>) {
  return admission.allowed ? undefined : admission
}

/** Admission and attach, the way both entrypoints compose them. */
async function attach(
  policy: SessionAccessPolicy,
  access: PtyStreamAccess,
  options: { now?: () => number } = {},
) {
  const admission = await authorizePtyAttach({ policy, access, info })
  if (!admission.allowed) return { admission }
  const socket = fakeSocket()
  const connection = createAuthorizedPtyConnection({
    ptyId: "pty_1",
    policy,
    access,
    admission,
    ...(options.now ? { now: options.now } : {}),
  })
  connection.onOpen(socket)
  await settle()
  return { admission, socket, connection }
}

describe("attaching to a terminal", () => {
  test("a relayed caller the authority refuses never reaches the PTY", async () => {
    const terminal = pty()
    const { policy, state } = authority({ read: false })

    const { admission, socket } = await attach(policy, relayed())

    expect(refusalOf(admission)).toMatchObject({ status: 403, code: "private_session" })
    expect(socket).toBeUndefined()
    expect(terminal.connected).toBe(0)
    expect(state.calls).toEqual([{ operation: "pty_read" }])
  })

  test("the admission's own deadline is enforced before the terminal is attached", async () => {
    const terminal = pty()
    const { policy } = authority()
    const socket = fakeSocket()
    const stale: PtyStreamAdmission = { allowed: true, lease: "read-lease", expiresAt: Date.now() - 1 }

    createAuthorizedPtyConnection({ ptyId: "pty_1", policy, access: relayed(), admission: stale }).onOpen(socket)
    await settle()

    expect(terminal.connected).toBe(0)
    expect(socket.sent).toEqual([])
    expect(socket.closes).toEqual([{ code: 1008, reason: "Session access expired" }])
  })

  test("a client gone before the attach runs is never connected", async () => {
    const terminal = pty()
    const { policy } = authority()
    const admission = await authorizePtyAttach({ policy, access: relayed(), info })
    const socket = fakeSocket()
    const connection = createAuthorizedPtyConnection({
      ptyId: "pty_1",
      policy,
      access: relayed(),
      admission: admission as PtyStreamAdmission,
    })

    connection.onOpen(socket)
    connection.onClose()
    await settle()

    expect(terminal.connected).toBe(0)
    expect(socket.sent).toEqual([])
  })

  test("an authority that throws fails closed", async () => {
    const terminal = pty()
    const { policy } = authority({ throws: true })

    const { admission } = await attach(policy, relayed())

    expect(refusalOf(admission)).toMatchObject({ status: 503, code: "pty_stream_authority_unavailable" })
    expect(terminal.connected).toBe(0)
  })

  test("a managed policy with no stream capability fails closed", async () => {
    const terminal = pty()
    const { policy } = authority({ omitStream: true })

    const { admission } = await attach(policy, relayed())

    expect(refusalOf(admission)).toMatchObject({ status: 503, code: "pty_stream_authority_unavailable" })
    expect(terminal.connected).toBe(0)
  })

  test("a managed policy with no stream capability keeps the refusal it can state", async () => {
    const { policy } = authority({ omitStream: true, read: false })

    const { admission } = await attach(policy, relayed())

    expect(refusalOf(admission)).toMatchObject({ status: 403, code: "private_session" })
  })

  test("the machine's own user attaches with no authority asked and types", async () => {
    const terminal = pty()
    const { policy, state } = authority()

    const { connection } = await attach(policy, local)
    connection!.onMessage("ls\r")
    await settle()

    expect(terminal.connected).toBe(1)
    expect(terminal.typed).toEqual(["ls\r"])
    expect(state.calls).toEqual([])
    expect(state.authorizeCalls).toEqual([])
  })

  test("each attach asks for its own authority", async () => {
    pty()
    const { policy, state } = authority()
    const first = await attach(policy, relayed())
    first.connection?.onClose()

    state.read = false
    const second = await attach(policy, relayed())

    expect(state.calls).toEqual([{ operation: "pty_read" }, { operation: "pty_read" }])
    expect(refusalOf(second.admission)).toMatchObject({ status: 403 })
  })
})

describe("typing at a terminal", () => {
  test("a read-only grant keeps its output and loses its keystrokes", async () => {
    const terminal = pty()
    const { policy, state } = authority({ write: false })

    const { connection, socket } = await attach(policy, relayed())
    connection!.onMessage("rm -rf /\r")
    await settle()

    expect(terminal.typed).toEqual([])
    expect(socket!.closes).toEqual([])
    terminal.attached?.send("output after the refused keystroke")
    expect(socket!.sent).toEqual(["output after the refused keystroke"])
    expect(state.calls).toEqual([{ operation: "pty_read" }, { operation: "pty_write" }])
  })

  test("a refused writer is answered locally rather than re-asked per keystroke", async () => {
    pty()
    const { policy, state } = authority({ write: false })

    const { connection } = await attach(policy, relayed())
    for (const key of ["a", "b", "c", "d"]) connection!.onMessage(key)
    await settle()

    expect(state.calls.filter((call) => call.operation === "pty_write")).toHaveLength(1)
  })

  test("keystrokes reach the terminal in arrival order across their write decisions", async () => {
    const terminal = pty()
    const { policy } = authority()
    // Each write decision answers faster than the one before it, so a queue
    // that let them run together would deliver the keystrokes backwards.
    let pending = 3
    const slow: SessionAccessPolicy = {
      ...policy,
      authorizeStream: async (request, lease) => {
        if (request.operation !== "pty_write") return { allowed: true, lease: "read-lease", expiresAt: Date.now() + 15_000 }
        await new Promise((resolve) => setTimeout(resolve, pending-- * 10))
        // Still valid, but within the renewal window, so every keystroke asks
        // for its own decision without accepting an expired grant.
        return { allowed: true, lease: lease ?? "write-lease", expiresAt: Date.now() + 500 }
      },
    }

    const { connection } = await attach(slow, relayed())
    connection!.onMessage("first")
    connection!.onMessage("second")
    connection!.onMessage("third")
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(terminal.typed).toEqual(["first", "second", "third"])
  })

  test("a promised binary frame keeps its place in the queue", async () => {
    const terminal = pty()
    const { policy } = authority()

    const { connection } = await attach(policy, local)
    connection!.onMessage(Promise.resolve(new TextEncoder().encode("binary").buffer))
    connection!.onMessage("text")
    await settle()

    expect(terminal.typed).toHaveLength(2)
    expect(new TextDecoder().decode(terminal.typed[0] as ArrayBuffer)).toBe("binary")
    expect(terminal.typed[1]).toBe("text")
  })

  test("a keystroke whose write decision lands after the client left is dropped", async () => {
    const terminal = pty()
    const { policy } = authority()
    const slow: SessionAccessPolicy = {
      ...policy,
      authorizeStream: async (request, lease) => {
        if (request.operation === "pty_write") await new Promise((resolve) => setTimeout(resolve, 40))
        return policy.authorizeStream!(request, lease)
      },
    }

    const { connection } = await attach(slow, relayed())
    connection!.onMessage("late\r")
    connection!.onClose()
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(terminal.typed).toEqual([])
    expect(terminal.disconnects).toBe(1)
  })

  test("a keystroke whose write decision outlives the read deadline is dropped", async () => {
    const terminal = pty()
    const { policy } = authority({ leaseMs: 30 })
    const slow: SessionAccessPolicy = {
      ...policy,
      authorizeStream: async (request, lease) => {
        if (request.operation === "pty_write") await new Promise((resolve) => setTimeout(resolve, 60))
        return policy.authorizeStream!(request, lease)
      },
    }

    const { connection, socket } = await attach(slow, relayed())
    connection!.onMessage("late\r")
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(terminal.typed).toEqual([])
    expect(socket!.closes).toEqual([{ code: 1008, reason: "Session access expired" }])
  })

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("an expired or malformed write deadline (%s) never admits a keystroke", async (offset) => {
    const terminal = pty()
    const { policy } = authority()
    const stale: SessionAccessPolicy = {
      ...policy,
      authorizeStream: async (request, lease) => request.operation === "pty_write"
        ? { allowed: true, lease: "stale-write", expiresAt: Date.now() + offset }
        : policy.authorizeStream!(request, lease),
    }
    const { connection, socket } = await attach(stale, relayed())
    connection!.onMessage("must not reach the shell")
    await settle()
    expect(terminal.typed).toEqual([])
    expect(socket!.closes).toEqual([])
    connection!.onClose()
  })
})

describe("a grant taken away while the socket is open", () => {
  test("the stream closes within the renewal window and releases nothing after", async () => {
    const terminal = pty()
    const { policy, state } = authority({ leaseMs: 1_500 })

    const { socket } = await attach(policy, relayed())
    expect(terminal.connected).toBe(1)

    state.read = false
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    terminal.attached?.send("output after the grant was removed")

    expect(socket!.sent).toEqual([])
    expect(socket!.closes).toEqual([{ code: 1008, reason: "Session access denied" }])
    expect(terminal.disconnects).toBe(1)
    expect(state.calls).toEqual([
      { operation: "pty_read" },
      { operation: "pty_read", lease: "pty_read-lease" },
    ])
  }, 10_000)

  test("output stops at the deadline even while the renewal is still in flight", async () => {
    const terminal = pty()
    const { policy } = authority()
    let clock = Date.now()
    const held: SessionAccessPolicy = {
      ...policy,
      authorizeStream: async () => ({ allowed: true, lease: "lease", expiresAt: clock + 1_000 }),
    }

    const { socket } = await attach(held, relayed(), { now: () => clock })
    terminal.attached?.send("inside the lease")
    clock += 1_001
    terminal.attached?.send("past the lease")

    expect(socket!.sent).toEqual(["inside the lease"])
    expect(terminal.attached?.readyState).toBe(3)
  })

  test("a terminal that has gone away closes the socket on the next keystroke", async () => {
    const terminal = pty()
    const { policy } = authority()

    const { connection, socket } = await attach(policy, local)
    spyOn(Pty, "get").mockReturnValue(undefined)
    connection!.onMessage("ls\r")
    await settle()

    expect(terminal.typed).toEqual([])
    expect(socket!.closes).toEqual([{ code: 1008, reason: "Session not found" }])
  })
})

describe("admission before the upgrade", () => {
  test("a workspace viewer is refused a terminal whatever the session says", async () => {
    const { policy, state } = authority()
    const admission = await authorizePtyAttach({ policy, access: relayed("viewer"), info })

    expect(refusalOf(admission)).toMatchObject({ status: 403, code: "relay_role_denied" })
    expect(state.calls).toEqual([])
    expect(state.authorizeCalls).toEqual([])
  })

  test("a terminal bound to no session is not reachable by a relayed caller", async () => {
    const { policy } = authority()
    const admission = await authorizePtyAttach({
      policy,
      access: relayed(),
      info: { ...info, sessionId: undefined },
    })

    expect(refusalOf(admission)).toMatchObject({ status: 404 })
  })

  test("the machine's own user is admitted without a question, on no deadline", async () => {
    const { policy, state } = authority()
    const admission = await authorizePtyAttach({ policy, access: local, info })

    expect(admission).toEqual({ allowed: true })
    expect(state.calls).toEqual([])
    expect(state.authorizeCalls).toEqual([])
  })

  test("a relayed caller is admitted on the authority's own lease and deadline", async () => {
    const { policy } = authority({ leaseMs: 30_000 })
    const admission = await authorizePtyAttach({ policy, access: relayed(), info })

    expect(admission.allowed).toBe(true)
    expect((admission as PtyStreamAdmission).lease).toBe("pty_read-lease")
    expect((admission as PtyStreamAdmission).expiresAt).toBeGreaterThan(Date.now())
  })
})

describe("the identity a stream carries into policy", () => {
  test("a verified stamp becomes the actor and workspace authority; nothing else does", () => {
    const access = ptyStreamAccess({
      identity: identity("admin", "actor_7"),
      authorization: "Bearer relay-token",
      method: "GET",
      path: "/pty_1/connect",
    })

    expect(access.actor).toEqual({ actorId: "actor_7", actorKind: "human" })
    expect(access.authority).toEqual({ managed: true, workspaceId: "ws_1", orgId: "org_1", role: "admin" })
    expect(access.credential).toBe("Bearer relay-token")
    expect(ptyStreamAccess({ authorization: "Bearer relay-token", method: "GET", path: "/x" })).toEqual({
      method: "GET",
      path: "/x",
    })
  })
})
