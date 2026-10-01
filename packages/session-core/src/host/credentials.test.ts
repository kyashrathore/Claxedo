import { expect, test } from "bun:test"
import type { LaunchComposer } from "./launch"
import { createHostFixture, sessionCreate, until } from "../../../workspace-runtime/src/test-support/host-fixture"
import { FakeTransport } from "../../../workspace-runtime/src/test-support/fake-transport"

const binding = (person: string) => ({ baseUrl: `https://${person}.example`, placeholder: person, authMode: "api-key" as const })

function fixture(accounts: Record<string, Record<string, ReturnType<typeof binding>>> = { A: { openai: binding("A") }, B: { openai: binding("B") } }) {
  const transport = new FakeTransport()
  const snapshot = { machineOwnerUserId: "A", accounts,
    placement: "loopback" as const, canUseOwnLogin: true, leaseGeneration: "test" }
  const launch: LaunchComposer = { workspaceId: "ws", projection: () => ({ generation: "test", mcpServers: [], pluginRoots: [], notApplied: [] }),
    credentials: () => snapshot }
  return { ...createHostFixture({ transports: { pi: transport }, launch }), transport }
}

test("a member turn in A's session spends A's account", async () => {
  const f = fixture()
  try {
    const session = await f.runtime.sessions.create({ ...sessionCreate({ id: "owned" }), owner: { kind: "person", userId: "A" } })
    await f.runtime.turns.start({ sessionId: session.id, messageId: "member-turn", text: "hello",
      origin: { actor: { kind: "person", userId: "B" }, via: "relay", reissued: false } })
    await until(() => f.transport.turns.length === 1)
    expect(f.transport.turns[0].turn.origin.actor).toEqual({ kind: "person", userId: "B" })
    expect(f.transport.starts[0].credentials).toMatchObject({ providers: { openai: binding("A") }, machineLoginAllowed: true, accountOwner: "A" })
    expect(JSON.stringify(f.transport.starts[0].credentials)).not.toContain("B.example")
  } finally { await f.dispose() }
})

test("owner and member sessions each use their own bound account", async () => {
  const f = fixture()
  try {
    for (const userId of ["A", "B"]) {
      await f.runtime.sessions.create({ ...sessionCreate({ id: `session-${userId}` }), owner: { kind: "person", userId } })
    }
    expect(f.transport.starts.map((input) => input.credentials.providers)).toEqual([
      { openai: binding("A") }, { openai: binding("B") },
    ])
    expect(f.transport.starts[1].credentials.machineLoginAllowed).toBe(false)
  } finally { await f.dispose() }
})

test("a non-owner without an account is refused before transport.start", async () => {
  const f = fixture()
  try {
    await expect(f.runtime.sessions.create({ ...sessionCreate({ id: "unbound" }), owner: { kind: "person", userId: "C" } }))
      .rejects.toMatchObject({ code: "account_unavailable", retryable: false })
    expect(f.transport.starts).toHaveLength(0)
  } finally { await f.dispose() }
})

test("the machine owner without an account may use the machine login", async () => {
  const f = fixture({ A: {}, B: {} })
  try {
    await f.runtime.sessions.create(sessionCreate({ id: "machine" }))
    expect(f.transport.starts[0].credentials).toMatchObject({ providers: {}, machineLoginAllowed: true, accountOwner: "A" })
  } finally { await f.dispose() }
})

test("a child session inherits its parent's owner, whoever asks for it", async () => {
  const f = fixture()
  try {
    await f.runtime.sessions.create({ ...sessionCreate({ id: "member-parent" }), owner: { kind: "person", userId: "B" } })
    await f.runtime.sessions.create({ ...sessionCreate({ id: "child" }), parentID: "member-parent", owner: { kind: "machine-owner" } })
    expect(f.transport.starts[1]).toMatchObject({ owner: { kind: "person", userId: "B" },
      credentials: { accountOwner: "B", machineLoginAllowed: false, providers: { openai: binding("B") } } })
    await expect(f.runtime.sessions.create({ ...sessionCreate({ id: "orphan" }), parentID: "missing-parent" }))
      .rejects.toMatchObject({ code: "account_unavailable" })
  } finally { await f.dispose() }
})

test("a create cannot rewrite the owner an existing session already spends for", async () => {
  const f = fixture()
  try {
    await f.runtime.sessions.create({ ...sessionCreate({ id: "owned" }), owner: { kind: "person", userId: "A" } })
    await expect(f.runtime.sessions.create({ ...sessionCreate({ id: "owned" }), owner: { kind: "person", userId: "B" } }))
      .rejects.toMatchObject({ code: "account_unavailable" })
  } finally { await f.dispose() }
})

test("the machine owner re-creating their session by name is the same account holder, not another owner", async () => {
  const f = fixture()
  try {
    await f.runtime.sessions.create({ ...sessionCreate({ id: "owned" }), owner: { kind: "machine-owner" } })
    await f.runtime.sessions.create({ ...sessionCreate({ id: "owned" }), owner: { kind: "person", userId: "A" } })
    expect(f.transport.starts.map((input) => input.credentials.accountOwner)).toEqual(["A", "A"])
  } finally { await f.dispose() }
})
