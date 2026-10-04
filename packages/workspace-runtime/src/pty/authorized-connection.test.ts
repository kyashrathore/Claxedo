import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Pty } from "./index"
import { createAuthorizedPtyConnection, ptyStreamAccess, type PtyStreamSocket } from "./authorized-connection"
import { admitTerminal, type TerminalAccess, type TerminalAdmission } from "./terminal-authority"
import { managedWorkspaceSessionAccessPolicy, type SessionAccessPolicy } from "@claxedo/session-core"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"

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

function relayed(role: NonNullable<RelayHostAuthContext["relayHostAuth"]>["role"] = "editor", sessionScope?: string): TerminalAccess {
  return ptyStreamAccess({
    identity: { ...identity(role), ...(sessionScope ? { session_id: sessionScope } : {}) },
    authorization: "Bearer relay-token",
    method: "GET",
    path: "/pty_1/connect",
  })
}

const local: TerminalAccess = ptyStreamAccess({ method: "GET", path: "/pty_1/connect" })

type HostCall = { hostAccess: string; lease?: string }

/**
 * The control plane's host authority, reduced to the verdict a terminal asks
 * it for and the lease lifetime it answers with. `active` is flipped per test
 * to stand for the workspace token being revoked while a socket is open.
 */
function authority(options: { active?: boolean; leaseMs?: number; throws?: boolean; omitHost?: boolean } = {}) {
  const state = {
    active: options.active ?? true,
    leaseMs: options.leaseMs ?? 15_000,
    throws: options.throws ?? false,
    calls: [] as HostCall[],
    leases: 0,
  }
  const policy: SessionAccessPolicy = managedWorkspaceSessionAccessPolicy({ requireActor: false })
  if (!options.omitHost) {
    policy.authorizeHost = async (request) => {
      state.calls.push({ hostAccess: request.hostAccess, ...(request.lease ? { lease: request.lease } : {}) })
      if (state.throws) throw new Error("authority is down")
      if (!state.active) return { allowed: false, status: 401, code: "runtime_access_token_inactive", message: "Runtime Access Token is inactive" }
      state.leases += 1
      return { allowed: true, lease: `host-lease-${state.leases}`, expiresAt: Date.now() + state.leaseMs }
    }
  }
  return { state, policy }
}

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("attach refuses an invalid lease deadline (%s)", async (offset) => {
  const { policy } = authority({ leaseMs: offset })
  const result = await admitTerminal(policy, relayed())
  expect(result).toMatchObject({ allowed: false, status: 503, code: "pty_stream_authority_unavailable" })
})

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

function refusalOf(admission: TerminalAdmission | { allowed: false; status: number; code: string }) {
  return admission.allowed ? undefined : admission
}

/** Admission and attach, the way both entrypoints compose them. */
async function attach(
  policy: SessionAccessPolicy,
  access: TerminalAccess,
  options: { now?: () => number } = {},
) {
  const admission = await admitTerminal(policy, access)
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
  test("a relayed caller whose workspace token is revoked never reaches the PTY", async () => {
    const terminal = pty()
    const { policy, state } = authority({ active: false })

    const { admission, socket } = await attach(policy, relayed())

    expect(refusalOf(admission)).toMatchObject({ status: 401, code: "runtime_access_token_inactive" })
    expect(socket).toBeUndefined()
    expect(terminal.connected).toBe(0)
    expect(state.calls).toEqual([{ hostAccess: "read" }])
  })

  test("a terminal labelled with another session is the workspace's and attaches", async () => {
    const terminal = pty()
    const { policy } = authority()

    const { admission } = await attach(policy, relayed())

    expect(admission.allowed).toBe(true)
    expect(terminal.connected).toBe(1)
  })

  test("the admission's own deadline is enforced before the terminal is attached", async () => {
    const terminal = pty()
    const { policy } = authority()
    const socket = fakeSocket()
    const stale: TerminalAdmission = { allowed: true, lease: "host-lease", expiresAt: Date.now() - 1 }

    createAuthorizedPtyConnection({ ptyId: "pty_1", policy, access: relayed(), admission: stale }).onOpen(socket)
    await settle()

    expect(terminal.connected).toBe(0)
    expect(socket.sent).toEqual([])
    expect(socket.closes).toEqual([{ code: 1008, reason: "Terminal access expired" }])
  })

  test("a client gone before the attach runs is never connected", async () => {
    const terminal = pty()
    const { policy } = authority()
    const admission = await admitTerminal(policy, relayed())
    const socket = fakeSocket()
    const connection = createAuthorizedPtyConnection({
      ptyId: "pty_1",
      policy,
      access: relayed(),
      admission: admission as TerminalAdmission,
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

  test("a managed policy with no host authority fails closed", async () => {
    const terminal = pty()
    const { policy } = authority({ omitHost: true })

    const { admission } = await attach(policy, relayed())

    expect(refusalOf(admission)).toMatchObject({ status: 503, code: "host_authority_required" })
    expect(terminal.connected).toBe(0)
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
  })

  test("each attach asks for its own authority", async () => {
    pty()
    const { policy, state } = authority()
    const first = await attach(policy, relayed())
    first.connection?.onClose()

    state.active = false
    const second = await attach(policy, relayed())

    expect(state.calls).toEqual([{ hostAccess: "read" }, { hostAccess: "read" }])
    expect(refusalOf(second.admission)).toMatchObject({ status: 401 })
  })
})

describe("typing at a terminal", () => {
  test("an editor's keystrokes reach the terminal without a question per keystroke", async () => {
    const terminal = pty()
    const { policy, state } = authority()

    const { connection } = await attach(policy, relayed())
    for (const key of ["a", "b", "c", "d"]) connection!.onMessage(key)
    await settle()

    expect(terminal.typed).toEqual(["a", "b", "c", "d"])
    expect(state.calls).toEqual([{ hostAccess: "read" }])
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

  test("a keystroke that arrives after the lease ran out is dropped and the socket closed", async () => {
    const terminal = pty()
    const { policy } = authority()
    let clock = Date.now()

    const { connection, socket } = await attach(policy, relayed(), { now: () => clock })
    clock += 15_001
    connection!.onMessage("late\r")
    await settle()

    expect(terminal.typed).toEqual([])
    expect(socket!.closes).toEqual([{ code: 1008, reason: "Terminal access expired" }])
  })
})

describe("a workspace token revoked while the socket is open", () => {
  test("the stream closes within the renewal window and releases nothing after", async () => {
    const terminal = pty()
    const { policy, state } = authority({ leaseMs: 1_500 })

    const { socket } = await attach(policy, relayed())
    expect(terminal.connected).toBe(1)

    state.active = false
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    terminal.attached?.send("output after the token was revoked")

    expect(socket!.sent).toEqual([])
    expect(socket!.closes).toEqual([{ code: 1008, reason: "Terminal access denied" }])
    expect(terminal.disconnects).toBe(1)
    expect(state.calls).toEqual([
      { hostAccess: "read" },
      { hostAccess: "read", lease: "host-lease-1" },
    ])
  }, 10_000)

  test("output stops at the deadline even while the renewal is still in flight", async () => {
    const terminal = pty()
    const { policy } = authority()
    let clock = Date.now()
    policy.authorizeHost = async () => ({ allowed: true, lease: "lease", expiresAt: clock + 1_000 })

    const { socket } = await attach(policy, relayed(), { now: () => clock })
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
    expect(socket!.closes).toEqual([{ code: 1008, reason: "Terminal not found" }])
  })
})

describe("admission before the upgrade", () => {
  test("a cloud runtime admits no unstamped caller", async () => {
    const admission = await admitTerminal(managedWorkspaceSessionAccessPolicy({ requireActor: true }), local)

    expect(refusalOf(admission)).toMatchObject({ status: 403, code: "session_actor_required" })
  })

  test("a token scoped to one session is refused a terminal, even one labelled with it", async () => {
    const { policy, state } = authority()
    const admission = await admitTerminal(policy, relayed("editor", info.sessionId))

    expect(refusalOf(admission)).toMatchObject({ status: 403, code: "relay_scope_denied" })
    expect(state.calls).toEqual([])
  })

  test("a workspace viewer is refused a terminal without asking the authority", async () => {
    const { policy, state } = authority()
    const admission = await admitTerminal(policy, relayed("viewer"))

    expect(refusalOf(admission)).toMatchObject({ status: 403, code: "terminal_role_denied" })
    expect(state.calls).toEqual([])
  })

  test("the machine's own user is admitted without a question, on no deadline", async () => {
    const { policy, state } = authority()
    const admission = await admitTerminal(policy, local)

    expect(admission).toEqual({ allowed: true })
    expect(state.calls).toEqual([])
  })

  test("a relayed editor is admitted on the authority's own lease and deadline", async () => {
    const { policy } = authority({ leaseMs: 30_000 })
    const admission = await admitTerminal(policy, relayed())

    expect(admission.allowed).toBe(true)
    expect((admission as TerminalAdmission).lease).toBe("host-lease-1")
    expect((admission as TerminalAdmission).expiresAt).toBeGreaterThan(Date.now())
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
