import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HOST_ENROLLMENT_OPERATIONS,
  accountConnectorTransport,
  machineIdentityFile,
  setupHostConnector,
  type AccountOperationRunner,
} from "./index"
import { HOSTED_OPERATIONS, resolveHostedOperation } from "../account/hosted-operations"
import type { SafeStorageApi } from "../account/credential-store"

/**
 * What this assembly has to get right.
 *
 * The protocol is already tested in `@claxedo/host-connector`; repeating it
 * here would test the dependency. What is only true HERE is the wiring: that
 * every call travels as a NAMED account operation rather than a URL, that the
 * account credential never comes near the connector, that an insecure machine
 * produces no enrollment traffic at all, and that starting twice does not leave
 * two heartbeat timers beating for one machine.
 */

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "claxedo-host-connector-"))
  dirs.push(dir)
  return dir
}

function fakeSafeStorage(overrides: Partial<SafeStorageApi> = {}): SafeStorageApi {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(JSON.stringify({ sealed: plain }), "utf8"),
    decryptString: (buffer) => {
      const parsed = JSON.parse(buffer.toString("utf8")) as { sealed?: string }
      if (typeof parsed.sealed !== "string") throw new Error("not sealed by this backend")
      return parsed.sealed
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
    ...overrides,
  }
}

type Call = { name: string; input: Record<string, unknown> | undefined }

/** A runner that answers the three enrollment operations, and records them. */
function fakeRunner(responses: Partial<Record<string, unknown>> = {}) {
  const calls: Call[] = []
  const run: AccountOperationRunner = async (name, input) => {
    calls.push({ name, input })
    if (name in responses) {
      const answer = responses[name]
      if (answer instanceof Error) throw answer
      return answer
    }
    if (name === HOST_ENROLLMENT_OPERATIONS.createRequest) {
      return { request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 }
    }
    if (name === HOST_ENROLLMENT_OPERATIONS.enroll) {
      return { enrollment: { enrollment_id: "enr_1", host_id: String(input?.["hostId"]), expires_at: 1_000 } }
    }
    if (name === HOST_ENROLLMENT_OPERATIONS.heartbeat) return { expires_at: 2_000 }
    throw new Error(`unexpected operation ${name}`)
  }
  return { run, calls }
}

/** A latch the test opens by hand. No timers, no wall clock. */
function latch() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/**
 * Poll until the test's own condition holds.
 *
 * A condition, never a duration: this is how a test proves a call is genuinely
 * in flight before it does the thing that has to race it. An unreachable
 * condition fails by name instead of hanging.
 */
async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (condition()) return
    await Bun.sleep(0)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function harness(
  input: {
    runner?: ReturnType<typeof fakeRunner>
    safeStorage?: SafeStorageApi
    userDataDir?: string
    /** Replaces the recording timer, for tests that need installing one to fail. */
    setInterval?: (fn: () => void, ms: number) => { cancel: () => void }
  } = {},
) {
  const runner = input.runner ?? fakeRunner()
  const ticks: Array<() => void> = []
  const cancels = { count: 0 }
  const errors: Array<{ stage: string; error: unknown }> = []
  const userDataDir = input.userDataDir ?? tempDir()
  const connector = setupHostConnector({
    run: runner.run,
    safeStorage: input.safeStorage ?? fakeSafeStorage(),
    userDataDir,
    platform: "darwin",
    displayName: "Work laptop",
    setInterval:
      input.setInterval ??
      ((fn) => {
        ticks.push(fn)
        return {
          cancel: () => {
            cancels.count++
          },
        }
      }),
    onError: (stage, error) => errors.push({ stage, error }),
  })
  return { connector, calls: runner.calls, ticks, cancels, errors, userDataDir }
}

/**
 * Fire every heartbeat timer this harness ever handed out, and report the
 * traffic that produced.
 *
 * The point of collecting ALL of them rather than the current one: an orphaned
 * timer is by definition the one nothing holds a handle to any more, so a test
 * that only fired the live timer would find nothing wrong with a machine that
 * is still publishing.
 */
async function beatEveryTimer(input: { ticks: Array<() => void>; calls: Call[] }) {
  const before = input.calls.length
  for (const tick of input.ticks) tick()
  await Bun.sleep(1)
  return input.calls.slice(before)
}

describe("the transport", () => {
  test("asks for the enrollment nonce by operation name", async () => {
    const runner = fakeRunner()

    const request = await accountConnectorTransport(runner.run).createRequest({ hostId: "host_a" })

    expect(request).toEqual({ request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 })
    expect(runner.calls[0]).toEqual({ name: "host.enrollmentNonce", input: { hostId: "host_a" } })
  })

  test("enrolls through the matrix's operation and unwraps the envelope", async () => {
    // `routes/hosted/host-enrollment.ts` returns `{ enrollment }`. Reading the
    // envelope's own fields would produce an enrollment with no id and an
    // expiry of NaN, which heartbeats happily forever.
    const runner = fakeRunner()

    const enrollment = await accountConnectorTransport(runner.run).enroll({
      hostId: "host_a",
      publicKey: '{"kty":"EC"}',
      requestId: "req_1",
      signature: "sig",
    })

    expect(enrollment).toEqual({ enrollment_id: "enr_1", host_id: "host_a", expires_at: 1_000 })
    expect(runner.calls[0]!.name).toBe("host.enrollCurrentMachine")
  })

  test("rejects an enrollment response that is not wrapped", async () => {
    const runner = fakeRunner({
      "host.enrollCurrentMachine": { enrollment_id: "enr_1", host_id: "host_a", expires_at: 1_000 },
    })

    const attempt = accountConnectorTransport(runner.run).enroll({
      hostId: "host_a",
      publicKey: "{}",
      requestId: "req_1",
      signature: "sig",
    })

    await expect(attempt).rejects.toThrow(/host\.enrollCurrentMachine.*enrollment_id/)
  })

  test("rejects a nonce response missing a field rather than signing undefined", async () => {
    const runner = fakeRunner({ "host.enrollmentNonce": { request_id: "req_1", expires_at: 1 } })

    await expect(accountConnectorTransport(runner.run).createRequest({ hostId: "host_a" })).rejects.toThrow(
      /host\.enrollmentNonce.*nonce/,
    )
  })

  test("heartbeats by name and decodes the new expiry", async () => {
    const runner = fakeRunner()

    const beat = await accountConnectorTransport(runner.run).heartbeat({ hostId: "host_a", signature: "sig" })

    expect(beat).toEqual({ expires_at: 2_000 })
    expect(runner.calls[0]!.name).toBe("host.enrollmentHeartbeat")
  })

  test("rejects a heartbeat response with a non-numeric expiry", async () => {
    const runner = fakeRunner({ "host.enrollmentHeartbeat": { expires_at: "soon" } })

    await expect(accountConnectorTransport(runner.run).heartbeat({ hostId: "host_a", signature: "s" })).rejects.toThrow(
      /host\.enrollmentHeartbeat/,
    )
  })
})

describe("the operation table", () => {
  test("enrollment resolves to the reviewed method and path", () => {
    const resolved = resolveHostedOperation(HOST_ENROLLMENT_OPERATIONS.enroll, {
      hostId: "host_a",
      publicKey: "{}",
      requestId: "req_1",
      signature: "sig",
    })

    expect(resolved.method).toBe("POST")
    expect(resolved.path).toBe("/api/claxedo/host/enrollments")
    expect(resolved.body).toMatchObject({ hostId: "host_a", publicKey: "{}", requestId: "req_1", signature: "sig" })
  })

  /**
   * All three, declared.
   *
   * This began as a tripwire pinning the OPPOSITE — the nonce and heartbeat
   * routes existed on the server but had no row in the reviewed operation
   * matrix, so the connector could not reach them and enrollment could never
   * have worked. The rows now exist, and this is the assertion that keeps them.
   *
   * Kept rather than deleted: the failure it guards against is silent. A
   * connector missing one operation still constructs, still starts, and simply
   * never enrolls.
   */
  test("every enrollment operation is declared in the reviewed table", () => {
    for (const name of Object.values(HOST_ENROLLMENT_OPERATIONS)) {
      expect(Object.keys(HOSTED_OPERATIONS), name).toContain(name)
    }
  })

  test("start() stops with the operation named when the runner returns the wrong shape", async () => {
    // The real resolver as the runner, which returns a REQUEST DESCRIPTOR
    // rather than a server response — so this exercises the transport's own
    // validation, and the assertion is that the failure names which operation
    // produced it.
    //
    // It was written when the nonce operation was undeclared and the resolver
    // threw for that reason. The rows now exist, so it passes for a different
    // reason than it was written for; the name says the new one. What it still
    // guards is the property that matters either way: a connector that cannot
    // complete the handshake STOPS and says which step failed, rather than
    // signing `undefined` and enrolling something meaningless.
    const errors: unknown[] = []
    const connector = setupHostConnector({
      run: async (name, params) => resolveHostedOperation(name, params),
      safeStorage: fakeSafeStorage(),
      userDataDir: tempDir(),
      platform: "darwin",
      setInterval: () => ({ cancel: () => {} }),
      onError: (_stage, error) => errors.push(error),
    })

    const status = await connector.start()

    expect(status).toMatchObject({ status: "stopped", reason: "error" })
    expect(String((status as { detail: string }).detail)).toContain("host.enrollmentNonce")
    expect(errors).toHaveLength(1)
  })
})

describe("setup", () => {
  test("constructs without enrolling anything", () => {
    const { connector, calls } = harness()

    expect(connector.status()).toEqual({ status: "not-started" })
    // An unsigned launch must not enroll a machine as a side effect of booting.
    expect(calls).toEqual([])
  })

  test("start enrolls once and begins heartbeating", async () => {
    const { connector, calls, ticks } = harness()

    const status = await connector.start()

    expect(status).toMatchObject({ status: "enrolled", enrollment: { enrollment_id: "enr_1" } })
    expect(calls.map((call) => call.name)).toEqual(["host.enrollmentNonce", "host.enrollCurrentMachine"])
    expect(ticks).toHaveLength(1)

    ticks[0]!()
    await Bun.sleep(1)
    expect(calls.map((call) => call.name)).toContain("host.enrollmentHeartbeat")
  })

  test("enrolls the persisted machine identity, with its display name", async () => {
    const { connector, calls } = harness()

    await connector.start()

    const enroll = calls.find((call) => call.name === "host.enrollCurrentMachine")!
    expect(String(enroll.input!["hostId"])).toStartWith("host_")
    expect(enroll.input!["displayName"]).toBe("Work laptop")
  })

  test("a second start neither re-enrolls nor starts a second timer", async () => {
    // Two timers for one machine is the failure that hides: heartbeats keep
    // working, and `stop()` cancels only one of them.
    const { connector, calls, ticks } = harness()

    await connector.start()
    await connector.start()

    expect(calls.filter((call) => call.name === "host.enrollCurrentMachine")).toHaveLength(1)
    expect(ticks).toHaveLength(1)
  })

  test("stop cancels the heartbeat timer and says why it stopped", async () => {
    const { connector, cancels } = harness()
    await connector.start()

    connector.stop()

    expect(cancels.count).toBe(1)
    expect(connector.status()).toMatchObject({ status: "stopped", reason: "closed" })
  })

  test("a stopped connector can be started again for the same machine", async () => {
    // Pause and resume: the enrollment is re-established, and the machine keeps
    // the identity it already has rather than appearing as a new laptop.
    const { connector, calls } = harness()
    await connector.start()
    const first = calls.find((call) => call.name === "host.enrollCurrentMachine")!.input!["hostId"]
    connector.stop()

    const status = await connector.start()

    expect(status).toMatchObject({ status: "enrolled" })
    const enrolls = calls.filter((call) => call.name === "host.enrollCurrentMachine")
    expect(enrolls).toHaveLength(2)
    expect(enrolls[1]!.input!["hostId"]).toBe(first)
  })

  test("a failed start is reported as stopped and can be retried", async () => {
    // `createHostConnector().start()` makes the nonce request outside its own
    // try, so this failure escapes as a rejection. If the half-built connector
    // were kept, its internal state would still read `idle` — so the status
    // would lie AND the next start would decide a live connector already
    // existed and never retry.
    const failing = { value: true }
    const inner = fakeRunner()
    const calls = inner.calls
    const { connector } = harness({
      runner: {
        calls,
        run: async (name, input) => {
          if (failing.value && name === HOST_ENROLLMENT_OPERATIONS.createRequest) {
            calls.push({ name, input })
            throw new Error("control plane unreachable")
          }
          return inner.run(name, input)
        },
      },
    })

    const first = await connector.start()

    expect(first).toMatchObject({ status: "stopped", reason: "error" })
    expect(connector.status()).toMatchObject({ status: "stopped", reason: "error" })

    failing.value = false
    expect(await connector.start()).toMatchObject({ status: "enrolled" })
    expect(calls.filter((call) => call.name === HOST_ENROLLMENT_OPERATIONS.createRequest)).toHaveLength(2)
  })

  test("a rejected heartbeat stops the loop instead of re-enrolling", async () => {
    const runner = fakeRunner({ "host.enrollmentHeartbeat": new Error("403 revoked") })
    const { connector, ticks, calls } = harness({ runner })
    await connector.start()

    ticks[0]!()
    await Bun.sleep(1)

    expect(connector.status()).toMatchObject({ status: "stopped", reason: "revoked" })
    expect(calls.filter((call) => call.name === "host.enrollCurrentMachine")).toHaveLength(1)
  })
})

/**
 * Two things happening at once.
 *
 * `ipc.ts` registers `start`, `pause` and `revoke` as named operations the
 * renderer invokes, so "the user clicked Enable twice" and "the user hit Revoke
 * while Enable was still spinning" are ordinary sequences, not thought
 * experiments. Every test here proves the overlap before asserting on it: it
 * holds the first call open at a seam and checks it is actually parked there
 * before issuing the second.
 */
describe("concurrent operations", () => {
  /** A runner that parks on one operation until the test opens the latch. */
  function gatedRunner(operation: string) {
    const inner = fakeRunner()
    const gate = latch()
    const arrived = { at: false }
    return {
      gate,
      arrived,
      calls: inner.calls,
      runner: {
        calls: inner.calls,
        run: async (name: string, params?: Record<string, unknown>) => {
          if (name === operation) {
            arrived.at = true
            await gate.opened
          }
          return inner.run(name, params)
        },
      } as ReturnType<typeof fakeRunner>,
    }
  }

  /**
   * A seam inside `loadOrCreateMachineIdentity`, which is where the window is.
   *
   * The window a second `start` slips through is the one BEFORE `connector` is
   * assigned — once it holds a connector, even a half-built one, the liveness
   * check turns the second call away. So a test that parks the first start at
   * the control plane proves nothing: by then the gap has already closed, and
   * the test passes against the very code it is meant to indict. `safeStorage`
   * is the last synchronous thing the mint touches before it writes, so a call
   * made from here is provably made while the first start is still inside its
   * identity load.
   */
  function duringIdentityMint() {
    const secure = fakeSafeStorage()
    const during: { run?: () => void } = {}
    return {
      during,
      safeStorage: {
        ...secure,
        encryptString: (plain: string) => {
          const run = during.run
          delete during.run
          run?.()
          return secure.encryptString(plain)
        },
      } satisfies SafeStorageApi,
    }
  }

  test("a second start during the first neither re-enrolls nor starts a second timer", async () => {
    // The orphan: both calls pass the liveness check because neither has
    // finished, the second connector replaces the first in the only variable
    // that holds one, and the first keeps beating with nothing able to stop it.
    const seam = duringIdentityMint()
    const { connector, calls, ticks } = harness({ safeStorage: seam.safeStorage })
    let second: Promise<unknown> | undefined
    // The overlap, proved: this runs while the first start is inside its
    // identity load, which is the only moment the gap exists.
    seam.during.run = () => {
      second = connector.start()
    }

    await connector.start()
    await second

    expect(second, "the second start never ran, so this test proved nothing").toBeDefined()
    expect(calls.filter((call) => call.name === HOST_ENROLLMENT_OPERATIONS.enroll)).toHaveLength(1)
    expect(ticks).toHaveLength(1)
  })

  test("pausing leaves nothing beating after two concurrent starts", async () => {
    // The invariant the user cares about, stated without reference to how many
    // connectors exist: a paused machine stops publishing. A second timer that
    // `stop()` cannot reach is a laptop that keeps announcing itself as
    // available after its owner turned it off.
    const seam = duringIdentityMint()
    const { connector, calls, ticks } = harness({ safeStorage: seam.safeStorage })
    let second: Promise<unknown> | undefined
    seam.during.run = () => {
      second = connector.start()
    }

    await connector.start()
    await second
    connector.stop()

    expect(second).toBeDefined()
    expect(await beatEveryTimer({ ticks, calls })).toEqual([])
  })

  test("a revoke during the handshake does not leave a machine publishing", async () => {
    // Revocation is the user taking this laptop off the network. An enrollment
    // that completes after it — because the request was already in flight —
    // must not become the process's live connector, or the machine goes on
    // heartbeating with a key whose only on-disk copy has been destroyed.
    const gated = gatedRunner(HOST_ENROLLMENT_OPERATIONS.enroll)
    const { connector, calls, ticks } = harness({ runner: gated.runner })

    const starting = connector.start()
    await until(() => gated.arrived.at, "the handshake to reach the enrollment call")
    connector.revoke()
    gated.gate.open()
    await starting

    expect(connector.status()).toMatchObject({ status: "stopped", reason: "revoked" })
    expect(await beatEveryTimer({ ticks, calls })).toEqual([])
  })

  test("a pause during the handshake does not leave a machine publishing", async () => {
    const gated = gatedRunner(HOST_ENROLLMENT_OPERATIONS.enroll)
    const { connector, calls, ticks } = harness({ runner: gated.runner })

    const starting = connector.start()
    await until(() => gated.arrived.at, "the handshake to reach the enrollment call")
    connector.stop()
    gated.gate.open()
    await starting

    expect(connector.status()).not.toMatchObject({ status: "enrolled" })
    expect(await beatEveryTimer({ ticks, calls })).toEqual([])
  })

  test("a handshake that fails after a revoke reports the revocation, not the failure", async () => {
    // The order the panel gets wrong most easily. The user revoked; the
    // enrollment that was already in flight then failed — as it should, its
    // machine is gone — and reporting that as a transport error offers "try
    // again" for something the user deliberately turned off.
    const gated = gatedRunner(HOST_ENROLLMENT_OPERATIONS.enroll)
    const { connector } = harness({
      runner: {
        calls: gated.calls,
        run: async (name: string, params?: Record<string, unknown>) => {
          const result = await gated.runner.run(name, params)
          if (name === HOST_ENROLLMENT_OPERATIONS.enroll) throw new Error("410 machine gone")
          return result
        },
      } as ReturnType<typeof fakeRunner>,
    })

    const starting = connector.start()
    await until(() => gated.arrived.at, "the handshake to reach the enrollment call")
    connector.revoke()
    gated.gate.open()
    await starting

    expect(connector.status()).toMatchObject({ status: "stopped", reason: "revoked" })
  })

  test("an escaping failure after a revoke still reports the revocation", async () => {
    // The other arm of the same ordering, through the catch that exists for
    // failures nobody predicted. `createHostConnector().start()` turns every
    // failure it knows about into a stopped STATE, so the only way into that
    // catch is something outside its try — installing the timer is the one
    // statement there, and a throw from it is the closest a test can get to the
    // unknown escape the catch was written for.
    const gated = gatedRunner(HOST_ENROLLMENT_OPERATIONS.enroll)
    const { connector, errors } = harness({
      runner: gated.runner,
      setInterval: () => {
        throw new Error("no timers available")
      },
    })

    const starting = connector.start()
    await until(() => gated.arrived.at, "the handshake to reach the enrollment call")
    connector.revoke()
    gated.gate.open()
    await starting

    expect(connector.status()).toMatchObject({ status: "stopped", reason: "revoked" })
    expect(errors.map((entry) => entry.stage)).toContain("enroll")
  })

  test("a revoke while the identity is being minted does not leave the key on disk", async () => {
    // `revoke` deletes the record, and the mint that was already running writes
    // one. Whichever order they land in, the private key must not outlive the
    // revocation — it is the only thing that can ever sign as this machine, and
    // `machine-identity.ts` keeps no other copy.
    const dir = tempDir()
    const secure = fakeSafeStorage()
    const onMint: { revoke?: () => void } = {}
    const { connector } = harness({
      userDataDir: dir,
      safeStorage: {
        ...secure,
        // The seam is the last thing the mint does before writing the record.
        encryptString: (plain) => {
          const revoke = onMint.revoke
          delete onMint.revoke
          revoke?.()
          return secure.encryptString(plain)
        },
      },
    })
    onMint.revoke = () => connector.revoke()

    await connector.start()

    expect(machineIdentityFile(dir).read()).toBeUndefined()
    expect(connector.status()).toMatchObject({ status: "stopped", reason: "revoked" })
  })
})

describe("refusing an insecure machine", () => {
  test("produces no identity, no enrollment traffic, and a reason", async () => {
    const { connector, calls, ticks } = harness({
      safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
    })

    const status = await connector.start()

    expect(status).toMatchObject({ status: "unavailable", reason: "no-secure-storage" })
    // The machine never announces itself, so there is no enrollment to
    // impersonate with a key it could not protect.
    expect(calls).toEqual([])
    expect(ticks).toEqual([])
  })
})

describe("what never crosses this boundary", () => {
  test("no account credential reaches the connector", async () => {
    // The connector signs with the machine key; the bearer is attached inside
    // the account service. A token arriving here would put the user's session
    // in a background child process.
    const { connector, calls } = harness()

    await connector.start()

    const sent = JSON.stringify(calls)
    expect(sent).not.toMatch(/authorization|bearer|access_?token/i)
  })

  test("no private key is sent, only the public half", async () => {
    const { connector, calls } = harness()

    await connector.start()

    const enroll = calls.find((call) => call.name === "host.enrollCurrentMachine")!
    const publicKey = JSON.parse(String(enroll.input!["publicKey"])) as JsonWebKey
    // A P-256 private JWK is the public one plus `d`.
    expect(publicKey.kty).toBe("EC")
    expect(publicKey).not.toHaveProperty("d")
  })

  test("only declared parameters are sent", async () => {
    const { connector, calls } = harness()

    await connector.start()

    for (const call of calls) {
      for (const key of Object.keys(call.input ?? {})) {
        expect(["hostId", "publicKey", "requestId", "signature", "displayName", "ttlMs"]).toContain(key)
      }
    }
  })
})

describe("machineIdentityFile", () => {
  test("round-trips and clears in the user data directory", () => {
    const dir = tempDir()
    const file = machineIdentityFile(dir)

    expect(file.read()).toBeUndefined()
    file.write("record")
    expect(file.read()).toBe("record")
    file.clear()
    expect(file.read()).toBeUndefined()
  })

  test("is owner-only on disk", () => {
    if (process.platform === "win32") return
    const dir = tempDir()

    machineIdentityFile(dir).write("record")

    const mode = statSync(join(dir, "host-machine-identity.json")).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("does not collide with the account credential", () => {
    // Same directory, different secrets and different lifetimes. One file
    // holding both would make an account sign-out able to delete the machine
    // key, which is a re-enrollment the user did not ask for.
    const dir = tempDir()
    machineIdentityFile(dir).write("record")

    expect(readFileSync(join(dir, "host-machine-identity.json"), "utf8")).toBe("record")
    expect(() => readFileSync(join(dir, "account-credential.json"), "utf8")).toThrow()
  })
})
