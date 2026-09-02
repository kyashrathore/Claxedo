import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  ACCOUNT_SIGN_IN_CHANNEL,
  ACCOUNT_SIGN_OUT_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  ACCOUNT_STREAM_CLOSE_CHANNEL,
  ACCOUNT_STREAM_OPEN_CHANNEL,
  ACCOUNT_STREAM_START_CHANNEL,
  RENDERER_WITHHELD_OPERATIONS,
  registerAccountIpc,
  type AccountIpcService,
} from "./account-ipc"
import { HOSTED_OPERATIONS, hostedOperationChannel } from "./hosted-operations"

/**
 * The IPC surface, checked in both directions.
 *
 * Exhaustive is the property: every operation reachable, and NOTHING reachable
 * that is not an operation. A test that only checked the first half would pass
 * with an extra `hostedFetch` channel sitting beside them.
 */

function harness(overrides: Partial<AccountIpcService> = {}) {
  const calls: Array<{ name: string; input: unknown }> = []
  const handlers = new Map<string, (event: never, ...args: never[]) => unknown>()
  const service: AccountIpcService = {
    state: () => ({ status: "signed", identity: { userId: "user_1" } }),
    signIn: async () => ({ ok: true, tokens: { accessToken: "at_1", expiresAt: 1 } }),
    signOut: async () => {},
    run: async (name, input) => {
      calls.push({ name, input })
      return { ran: name }
    },
    openStream: async () => {},
    ...overrides,
  }
  const registered = registerAccountIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
  })
  return {
    calls,
    registered,
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!(undefined as never, ...(args as never[])),
    invokeFrom: (sender: StreamSender, channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ sender } as unknown as never, ...(args as never[])),
    has: (channel: string) => handlers.has(channel),
    channels: () => [...handlers.keys()],
  }
}

class StreamSender extends EventEmitter {
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  private destroyed = false

  send(channel: string, payload: unknown) {
    this.sent.push({ channel, payload })
  }

  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    this.destroyed = true
    this.emit("destroyed")
  }
}

async function flushStreamSettlement() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

describe("registered channels", () => {
  test("exposes exactly one channel per operation, plus the account protocol", () => {
    // Both directions. An extra channel is the failure that matters, and only
    // an equality check finds it.
    const h = harness()
    const expected = [
      ACCOUNT_STATE_CHANNEL,
      ACCOUNT_SIGN_IN_CHANNEL,
      ACCOUNT_SIGN_OUT_CHANNEL,
      ACCOUNT_STREAM_OPEN_CHANNEL,
      ACCOUNT_STREAM_START_CHANNEL,
      ACCOUNT_STREAM_CLOSE_CHANNEL,
      ...Object.keys(HOSTED_OPERATIONS).map((name) => hostedOperationChannel(name as never)),
    ]

    expect(h.channels().toSorted()).toEqual(expected.toSorted())
  })

  test("registers no generic channel", () => {
    const h = harness()

    for (const channel of h.channels()) {
      expect(channel).not.toMatch(/fetch|proxy|invoke|request$/i)
    }
  })
})

describe("stream channels", () => {
  test("reserves an id without starting the service, then preserves synchronous chunks and end after start", async () => {
    const opened: string[] = []
    const h = harness({
      openStream: async ({ onChunk }) => {
        opened.push("opened")
        onChunk("first")
        onChunk("second")
      },
    })
    const sender = new StreamSender()

    const { streamId } = await h.invokeFrom(sender, ACCOUNT_STREAM_OPEN_CHANNEL, {
      operation: "session.events",
      input: { workspaceId: "ws_1" },
    }) as { streamId: string }

    expect(opened).toEqual([])
    expect(sender.sent).toEqual([])

    await h.invokeFrom(sender, ACCOUNT_STREAM_START_CHANNEL, { streamId })
    await flushStreamSettlement()

    expect(opened).toEqual(["opened"])
    expect(sender.sent).toEqual([
      { channel: "claxedo.account.stream.chunk", payload: { streamId, text: "first" } },
      { channel: "claxedo.account.stream.chunk", payload: { streamId, text: "second" } },
      { channel: "claxedo.account.stream.end", payload: { streamId } },
    ])
    expect(sender.listenerCount("destroyed")).toBe(0)
  })

  test("preserves a stream failure that happens synchronously during start", async () => {
    const h = harness({
      openStream: (() => {
        throw new Error("sync stream failure")
      }) as AccountIpcService["openStream"],
    })
    const sender = new StreamSender()
    const { streamId } = await h.invokeFrom(sender, ACCOUNT_STREAM_OPEN_CHANNEL, {
      operation: "session.events",
    }) as { streamId: string }

    await h.invokeFrom(sender, ACCOUNT_STREAM_START_CHANNEL, { streamId })
    await flushStreamSettlement()

    expect(sender.sent).toEqual([
      {
        channel: "claxedo.account.stream.error",
        payload: { streamId, message: "sync stream failure" },
      },
    ])
    expect(sender.listenerCount("destroyed")).toBe(0)
  })

  test("close before start aborts the reservation and refuses a later start", async () => {
    let opens = 0
    const h = harness({
      openStream: async () => {
        opens++
      },
    })
    const sender = new StreamSender()
    const { streamId } = await h.invokeFrom(sender, ACCOUNT_STREAM_OPEN_CHANNEL, {
      operation: "session.events",
    }) as { streamId: string }

    await h.invokeFrom(sender, ACCOUNT_STREAM_CLOSE_CHANNEL, { streamId })

    expect(opens).toBe(0)
    expect(sender.listenerCount("destroyed")).toBe(0)
    await expect(h.invokeFrom(sender, ACCOUNT_STREAM_START_CHANNEL, { streamId })).rejects.toThrow("unknown")
  })

  test("close aborts a running stream and suppresses its later terminal frame", async () => {
    let signal: AbortSignal | undefined
    let release!: () => void
    const h = harness({
      openStream: (input) => new Promise<void>((resolve) => {
        signal = input.signal
        release = resolve
      }),
    })
    const sender = new StreamSender()
    const { streamId } = await h.invokeFrom(sender, ACCOUNT_STREAM_OPEN_CHANNEL, {
      operation: "session.events",
    }) as { streamId: string }
    await h.invokeFrom(sender, ACCOUNT_STREAM_START_CHANNEL, { streamId })

    await h.invokeFrom(sender, ACCOUNT_STREAM_CLOSE_CHANNEL, { streamId })
    release()
    await flushStreamSettlement()

    expect(signal?.aborted).toBe(true)
    expect(sender.sent).toEqual([])
    expect(sender.listenerCount("destroyed")).toBe(0)
  })

  test("refuses duplicate, unknown, and cross-renderer starts", async () => {
    let release!: () => void
    const h = harness({
      openStream: () => new Promise<void>((resolve) => {
        release = resolve
      }),
    })
    const owner = new StreamSender()
    const other = new StreamSender()
    const { streamId } = await h.invokeFrom(owner, ACCOUNT_STREAM_OPEN_CHANNEL, {
      operation: "session.events",
    }) as { streamId: string }

    await expect(h.invokeFrom(other, ACCOUNT_STREAM_START_CHANNEL, { streamId })).rejects.toThrow("unknown")
    await h.invokeFrom(owner, ACCOUNT_STREAM_START_CHANNEL, { streamId })
    await expect(h.invokeFrom(owner, ACCOUNT_STREAM_START_CHANNEL, { streamId })).rejects.toThrow("already started")
    await expect(h.invokeFrom(owner, ACCOUNT_STREAM_START_CHANNEL, { streamId: "missing" })).rejects.toThrow("unknown")

    release()
    await flushStreamSettlement()
  })

  test("sender destruction aborts and removes both pending and running streams", async () => {
    let runningSignal: AbortSignal | undefined
    const h = harness({
      openStream: ({ signal }) => new Promise<void>(() => {
        runningSignal = signal
      }),
    })

    for (const start of [false, true]) {
      const sender = new StreamSender()
      const { streamId } = await h.invokeFrom(sender, ACCOUNT_STREAM_OPEN_CHANNEL, {
        operation: "session.events",
      }) as { streamId: string }
      if (start) await h.invokeFrom(sender, ACCOUNT_STREAM_START_CHANNEL, { streamId })

      sender.destroy()

      if (start) expect(runningSignal?.aborted).toBe(true)
      expect(sender.listenerCount("destroyed")).toBe(0)
      await expect(h.invokeFrom(sender, ACCOUNT_STREAM_START_CHANNEL, { streamId })).rejects.toThrow("unknown")
    }
  })
})

describe("operation channels", () => {
  test("bind the operation name at registration, not from the message", () => {
    // The renderer chooses WHICH channel to call. It cannot choose what that
    // channel does — otherwise the closed set is decoration.
    const h = harness()

    h.invoke(hostedOperationChannel("workspace.checkpoints.list"), { id: "ws_1", operation: "account.mode" })

    expect(h.calls).toEqual([{ name: "workspace.checkpoints.list", input: { id: "ws_1", operation: "account.mode" } }])
  })

  test("pass an empty object when the renderer sends nothing", async () => {
    // Otherwise `undefined` reaches the resolver and a missing-parameter error
    // reads as a crash rather than a bad call.
    const h = harness()

    await h.invoke(hostedOperationChannel("account.mode"))

    expect(h.calls[0]).toEqual({ name: "account.mode", input: {} })
  })

  test("return whatever the service decoded", async () => {
    const h = harness()

    expect(await h.invoke(hostedOperationChannel("account.mode"))).toEqual({ ran: "account.mode" })
  })
})

describe("operations whose result is a credential", () => {
  /**
   * The real body of `POST /api/auth/cli/exchange`.
   *
   * Copied from `mintCliSessionTokens` in
   * `@claxedo/server-core/platform/auth/cli-session-token`, spellings included,
   * because the point of the fixture is that these are the bytes that used to
   * cross the IPC boundary. A made-up `{ token: "x" }` would exercise the
   * handler without demonstrating what was at stake.
   */
  const CLI_TOKEN_PAIR = {
    access_token: "cli_at_live_1",
    refresh_token: "clirt_live_1",
    token_type: "Bearer",
    expires_in: 3600,
  }

  const cliChannel = hostedOperationChannel("account.cliExchange")

  /**
   * A service that mints, and RECORDS that it was asked to.
   *
   * The recording is deliberately rebuilt here rather than left to `harness`.
   * Overriding `run` replaces the harness's own recorder, so an earlier draft
   * of this block asserted `h.calls` was empty against a service that could
   * never have filled it — the assertion passed with the withhold reverted,
   * which is precisely the false green these tests exist to refuse.
   */
  const minting = () => {
    const ran: Array<{ name: string; input: unknown }> = []
    const h = harness({
      run: async (name, input) => {
        ran.push({ name, input })
        return CLI_TOKEN_PAIR
      },
    })
    return { ...h, ran }
  }

  test("every withheld name is a real operation", () => {
    // Pinned against the table rather than restated. A rename in
    // `hosted-operations.ts` would otherwise leave a withheld entry matching
    // nothing, and an empty withhold list refuses nothing at all.
    for (const name of RENDERER_WITHHELD_OPERATIONS) {
      expect(Object.keys(HOSTED_OPERATIONS)).toContain(name)
    }
    expect(RENDERER_WITHHELD_OPERATIONS).toContain("account.cliExchange")
  })

  test("the channel is still registered, so the surface matches the table", () => {
    // Withholding narrows what a channel DOES, not which channels exist —
    // the equality check above is what catches an extra one.
    expect(minting().has(cliChannel)).toBe(true)
  })

  test("invoking it never resolves the token pair", async () => {
    // The defect, stated as the renderer sees it: `account.cliExchange`
    // answers with a long-lived CLI access + refresh pair, and the generated
    // operation loop returned that body verbatim over IPC — breaking U8-R7,
    // which `signIn` in this same file was already written to uphold.
    const h = minting()

    let resolved: unknown = "<never settled>"
    let rejected: unknown
    try {
      resolved = await h.invoke(cliChannel, { code: "device_code_1" })
    } catch (error) {
      rejected = error
    }

    expect(rejected).toBeInstanceOf(Error)
    // Scanned as a VALUE, not asserted by shape: whatever crossed the boundary
    // must not contain the credential anywhere in it.
    const crossed = JSON.stringify(resolved === "<never settled>" ? null : (resolved ?? null))
    expect(crossed).not.toContain("cli_at_live_1")
    expect(crossed).not.toContain("clirt_live_1")
    expect(crossed).not.toContain("refresh_token")
  })

  test("refuses BEFORE the operation runs, so no session is minted", async () => {
    // Discarding the response would also keep the token out of the renderer,
    // and would still let a compromised one burn a real mint per call — every
    // exchange is recorded in the revocation registry. So the service must not
    // be reached at all.
    const h = minting()

    await h.invoke(cliChannel, { code: "device_code_1" }).catch(() => {})

    expect(h.ran).toEqual([])
  })

  test("withholds nothing else — every other operation still resolves", async () => {
    // Positive control for the branch. A refusal applied to the whole loop
    // would satisfy every assertion above and break the desktop entirely.
    // Stream ops refuse unary invoke on purpose (open via stream IPC).
    const h = harness()
    const withheld = new Set<string>(RENDERER_WITHHELD_OPERATIONS)
    const { isStreamHostedOperation } = await import("./hosted-operations")
    const ran: string[] = []

    for (const name of Object.keys(HOSTED_OPERATIONS)) {
      if (withheld.has(name) || isStreamHostedOperation(name)) continue
      expect(await h.invoke(hostedOperationChannel(name as never))).toEqual({ ran: name })
      ran.push(name)
    }

    const streamCount = Object.keys(HOSTED_OPERATIONS).filter((name) => isStreamHostedOperation(name)).length
    expect(ran.length).toBe(
      Object.keys(HOSTED_OPERATIONS).length - RENDERER_WITHHELD_OPERATIONS.length - streamCount,
    )
    expect(ran.length).toBeGreaterThan(0)
  })
})

describe("operations whose parameters are a machine identity", () => {
  /**
   * The enrollment handshake, as an ATTACKER's renderer would send it.
   *
   * `host.enrollCurrentMachine` declares `publicKey` and `signature` as body
   * fields filled from the caller, and `routes/hosted/host-enrollment.ts`
   * stores whatever public key it is handed. So a renderer holding this channel
   * generates a keypair, takes a nonce from `host.enrollmentNonce` — also on a
   * channel — signs it, and enrolls a machine whose private half Electron main
   * has never seen, on main's bearer and under the owner's account. Sending the
   * REAL `hostId` is worse still: `enrollForUser` patches the existing row,
   * overwriting `public_key` and clearing `revoked_at`, so the same call takes
   * over an honest machine and un-revokes one the user revoked.
   *
   * These are real field names and a real key shape, not `{ x: 1 }`: the point
   * of the fixture is that this is the message that used to reach the route.
   */
  const ATTACKER_ENROLLMENT = {
    hostId: "host_stolen_1",
    publicKey: '{"kty":"EC","crv":"P-256","x":"ATTACKER_PUBLIC_X","y":"ATTACKER_PUBLIC_Y"}',
    requestId: "req_1",
    signature: "ATTACKER_SIGNATURE",
    displayName: "macOS",
  }

  const MACHINE_OPERATIONS = [
    "host.enrollCurrentMachine",
    "host.enrollmentNonce",
    "host.enrollmentHeartbeat",
  ] as const

  /** A service that ANSWERS, and records what it was asked. See `minting`. */
  const enrolling = () => {
    const ran: Array<{ name: string; input: unknown }> = []
    const h = harness({
      run: async (name, input) => {
        ran.push({ name, input })
        return { enrollment: { enrollment_id: "enr_1", host_id: "host_stolen_1", expires_at: 1 } }
      },
    })
    return { ...h, ran }
  }

  test("every host operation is withheld from the renderer", () => {
    for (const name of MACHINE_OPERATIONS) {
      expect(RENDERER_WITHHELD_OPERATIONS, name).toContain(name)
    }
  })

  test("enrolling a renderer-supplied key never reaches the account service", async () => {
    // Refused BEFORE `service.run`, like the credential case: discarding the
    // response would keep the enrollment record out of the renderer and still
    // leave the attacker's machine enrolled, which is the whole damage.
    const h = enrolling()

    let rejected: unknown
    await h
      .invoke(hostedOperationChannel("host.enrollCurrentMachine"), ATTACKER_ENROLLMENT)
      .catch((error: unknown) => {
        rejected = error
      })

    expect(rejected).toBeInstanceOf(Error)
    expect(h.ran).toEqual([])
    // Scanned as a VALUE rather than asserted by shape: no part of the
    // attacker's key material may appear in anything the service was handed.
    expect(JSON.stringify(h.ran)).not.toContain("ATTACKER_PUBLIC_X")
    expect(JSON.stringify(h.ran)).not.toContain("ATTACKER_SIGNATURE")
  })

  test("the whole handshake is refused, not just its last step", async () => {
    // Withholding only `enrollCurrentMachine` would leave a renderer able to
    // mint nonces and heartbeat as a machine — step one and step four of the
    // same handshake — so the refusal covers all three.
    const h = enrolling()

    for (const name of MACHINE_OPERATIONS) {
      let rejected: unknown
      await h.invoke(hostedOperationChannel(name), ATTACKER_ENROLLMENT).catch((error: unknown) => {
        rejected = error
      })
      expect(rejected, name).toBeInstanceOf(Error)
    }

    expect(h.ran).toEqual([])
  })

  test("the channels are still registered, so the surface matches the table", () => {
    // Same reasoning as the credential case: withholding narrows what a
    // channel DOES. A missing channel would be indistinguishable from one
    // nobody wired, and would break the equality check that catches an EXTRA
    // one.
    const h = enrolling()

    for (const name of MACHINE_OPERATIONS) {
      expect(h.has(hostedOperationChannel(name)), name).toBe(true)
    }
  })
})

describe("account channels", () => {
  test("signIn returns the state, never the token set", async () => {
    // The flow's own result carries tokens. A handler that returned it would
    // put the credential on the IPC boundary — the one thing this arrangement
    // exists to prevent.
    const h = harness()

    const result = await h.invoke(ACCOUNT_SIGN_IN_CHANNEL)

    expect(result).toEqual({ status: "signed", identity: { userId: "user_1" } })
    expect(JSON.stringify(result)).not.toContain("at_1")
    expect(JSON.stringify(result)).not.toContain("accessToken")
  })

  test("signOut returns the state after signing out", async () => {
    let signedOut = false
    const h = harness({
      signOut: async () => {
        signedOut = true
      },
      state: () => (signedOut ? { status: "unsigned" } : { status: "signed", identity: { userId: "user_1" } }),
    })

    expect(await h.invoke(ACCOUNT_SIGN_OUT_CHANNEL)).toEqual({ status: "unsigned" })
  })

  test("state carries no credential", () => {
    const h = harness()

    expect(JSON.stringify(h.invoke(ACCOUNT_STATE_CHANNEL))).not.toMatch(/token|Bearer/i)
  })
})
