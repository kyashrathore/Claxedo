import { expect, test } from "bun:test"
import type { HarnessServices, HarnessSession, StartInput } from "../../contract"
import type { CursorHost, CursorHostKey } from "./host-registry"
import { CursorSdkTransport } from "./index"

function fixture() {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const calls: string[] = []
  const previous = { failed: true } as CursorHost
  const replacement = { failed: false, call: async () => {
    calls.push("replacement")
    return { kind: "result", value: { models: [{ id: "model", name: "Model" }] } }
  } } as unknown as CursorHost
  const acquired = new Map<CursorHost, number>([[previous, 1]])
  const released = new Map<CursorHost, number>()
  let users = 0
  const registry = {
    acquire: async () => {
      entered.resolve()
      await resume.promise
      acquired.set(replacement, (acquired.get(replacement) ?? 0) + 1)
      users++
      return replacement
    },
    release: async (_key: CursorHostKey, host: CursorHost) => {
      released.set(host, (released.get(host) ?? 0) + 1)
      if (host === replacement) users--
    },
  }
  const transport = new CursorSdkTransport({} as HarnessServices, { homeRoot: "/tmp", env: {}, placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: false })
  const session = { binding: { sessionId: "s1" } } as HarnessSession
  const entry = { session, input: { config: {}, credentials: { leaseGeneration: "g1" }, owner: { kind: "machine-owner" } } as StartInput,
    credential: { key: "key", apiKey: "test", bound: false, ownerLogin: false },
    host: { binding: "key", home: "/tmp" }, process: previous, busy: false, reopen: false }
  const internals = transport as unknown as { entries: Map<string, typeof entry>; registry: typeof registry;
    compose: () => Promise<{ home: string; local: object }> }
  internals.entries.set("s1", entry)
  internals.registry = registry
  internals.compose = async () => ({ home: "/tmp", local: {} })
  return { transport, session, entered, resume, acquired, released, calls, users: () => users }
}

test("close during a pending refresh releases every acquired host", async () => {
  const f = fixture()
  const probing = f.transport.config.options({ session: f.session }, "probe").then(() => "loaded", (error: Error) => error.message)
  await f.entered.promise
  const closing = f.transport.close(f.session)
  await new Promise((resolve) => setTimeout(resolve, 0))
  f.resume.resolve()
  const [probe] = await Promise.all([probing, closing])
  expect(f.users()).toBe(0)
  expect(f.released).toEqual(f.acquired)
  expect(probe).toContain("closing")
  expect(f.calls).toEqual([])
})

test("close during credential replacement releases the late acquisition exactly once", async () => {
  const f = fixture()
  const configuring = f.transport.configure(f.session, { credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {
    cursor: { baseUrl: "http://replacement", placeholder: "test", authMode: "bearer" },
  }, secrets: {}, leaseGeneration: "g2" } }).then(() => "configured", (error: Error) => error.message)
  await f.entered.promise
  const first = f.transport.close(f.session)
  const second = f.transport.close(f.session)
  f.resume.resolve()
  const [result] = await Promise.all([configuring, first, second])
  expect(result).toContain("closing")
  expect(f.users()).toBe(0)
  expect(f.released).toEqual(f.acquired)
  expect(f.calls).toEqual([])
})

test("configuration queued behind refresh cannot apply once close begins", async () => {
  const f = fixture()
  const probing = f.transport.config.options({ session: f.session }, "probe").then(() => "loaded", (error: Error) => error.message)
  await f.entered.promise
  const configuring = f.transport.config.update(f.session, { instructions: "changed" }).then(() => "configured", (error: Error) => error.message)
  const closing = f.transport.close(f.session)
  f.resume.resolve()
  const [probe, config] = await Promise.all([probing, configuring, closing])
  expect(probe).toContain("closing")
  expect(config).toContain("closing")
  expect(f.released).toEqual(f.acquired)
})

test("permission changes wait for refresh and close the replacement agent", async () => {
  const f = fixture()
  const probing = f.transport.config.options({ session: f.session }, "probe")
  await f.entered.promise
  let configured = false
  const configuring = f.transport.config.setPermissionMode(f.session, "review").then(() => { configured = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const earlyConfiguration = configured
  f.resume.resolve()
  await Promise.all([probing, configuring])
  expect(earlyConfiguration).toBe(false)
  expect(f.calls).toEqual(["replacement", "replacement"])
  await f.transport.close(f.session)
  expect(f.released).toEqual(f.acquired)
})
