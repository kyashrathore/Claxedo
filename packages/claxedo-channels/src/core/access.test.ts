import { describe, expect, test } from "vitest"
import {
  createChannelAccess,
  createMemoryChannelAccessStore,
  createMemoryChannelIdentityBindingStore,
  generatePairingCode,
  parseDmPolicy,
  parseGroupPolicy,
  seedAllows,
  PAIRING_MAX_PENDING_PER_CHANNEL,
  PAIRING_RESEND_INTERVAL_MS,
} from "./access"

function fixedClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

function seq(values: number[]) {
  let i = 0
  return () => values[i++ % values.length]
}

describe("pairing code generation", () => {
  test("is 8 chars from the unambiguous alphabet", () => {
    const code = generatePairingCode(seq([0, 0.5, 0.99, 0.1, 0.2, 0.3, 0.4, 0.6]))
    expect(code).toHaveLength(8)
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
    expect(code).not.toMatch(/[01OI]/)
  })
})

describe("seedAllows (immutable id matching)", () => {
  test("matches exact, channel-wildcard, and global wildcard", () => {
    expect(seedAllows(["telegram:123"], "telegram", "123")).toBe(true)
    expect(seedAllows(["telegram:*"], "telegram", "999")).toBe(true)
    expect(seedAllows(["*"], "telegram", "999")).toBe(true)
    expect(seedAllows(["telegram:123"], "telegram", "124")).toBe(false)
    expect(seedAllows(["slack:123"], "telegram", "123")).toBe(false)
    expect(seedAllows(undefined, "telegram", "123")).toBe(false)
  })
})

describe("policy parsing fails safe", () => {
  test("unknown dm policy falls back to pairing (strictest usable default)", () => {
    expect(parseDmPolicy(undefined)).toBe("pairing")
    expect(parseDmPolicy("garbage")).toBe("pairing")
    expect(parseDmPolicy("open")).toBe("open")
  })
  test("unknown group policy falls back to allowlist", () => {
    expect(parseGroupPolicy(undefined)).toBe("allowlist")
    expect(parseGroupPolicy("nonsense")).toBe("allowlist")
    expect(parseGroupPolicy("open")).toBe("open")
  })
})

describe("DM pairing gate", () => {
  test("unknown sender gets a code, message is dropped (no LLM path)", async () => {
    const store = createMemoryChannelAccessStore()
    const clock = fixedClock()
    const access = createChannelAccess({ dmPolicy: "pairing", store, now: clock.now, random: seq([0.1]) })

    const first = await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })
    expect(first.admission).toBe("drop")
    if (first.admission === "drop") {
      expect(first.reason).toBe("dm_pairing_required")
      expect(first.reply).toContain("pairing")
    }
    expect(await access.listPending("telegram")).toHaveLength(1)
  })

  test("resend is throttled to once per hour — no second code", async () => {
    const store = createMemoryChannelAccessStore()
    const clock = fixedClock()
    const access = createChannelAccess({ dmPolicy: "pairing", store, now: clock.now, random: seq([0.1]) })

    await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })
    clock.advance(60_000) // 1 minute later
    const second = await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })
    expect(second.admission).toBe("drop")
    if (second.admission === "drop") {
      expect(second.reason).toBe("dm_pairing_throttled")
      expect(second.reply).toBeUndefined()
    }

    clock.advance(PAIRING_RESEND_INTERVAL_MS)
    const third = await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })
    expect(third.admission).toBe("drop")
    if (third.admission === "drop") expect(third.reply).toContain("pairing")
  })

  test("pending queue is capped per channel", async () => {
    const store = createMemoryChannelAccessStore()
    const clock = fixedClock()
    const access = createChannelAccess({ dmPolicy: "pairing", store, now: clock.now, random: seq([0.1, 0.2, 0.3, 0.4, 0.5]) })

    for (let i = 0; i < PAIRING_MAX_PENDING_PER_CHANNEL; i++) {
      const d = await access.gate({ channel: "telegram", externalUserId: `u${i}`, chatType: "dm" })
      expect(d.admission).toBe("drop")
    }
    const overflow = await access.gate({ channel: "telegram", externalUserId: "u-overflow", chatType: "dm" })
    expect(overflow.admission).toBe("drop")
    if (overflow.admission === "drop") expect(overflow.reason).toBe("dm_pairing_queue_full")
    expect(await access.listPending("telegram")).toHaveLength(PAIRING_MAX_PENDING_PER_CHANNEL)
  })

  test("approve allowlists the sender and records a pending identity binding", async () => {
    const store = createMemoryChannelAccessStore()
    const bindings = createMemoryChannelIdentityBindingStore()
    const clock = fixedClock()
    const access = createChannelAccess({ dmPolicy: "pairing", store, bindings, now: clock.now, random: seq([0.1]) })

    await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })
    const [pending] = await access.listPending("telegram")
    const approved = await access.approve(pending.code, "owner:1")
    expect(approved).toEqual({ ok: true, channel: "telegram", externalUserId: "42" })

    const after = await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })
    expect(after.admission).toBe("allow")
    const binding = await bindings.get("telegram", "42")
    expect(binding).toMatchObject({ status: "pending", accountId: null, boundBy: "owner:1" })
  })

  test("approve rejects unknown and expired codes", async () => {
    const store = createMemoryChannelAccessStore()
    const clock = fixedClock()
    const access = createChannelAccess({ dmPolicy: "pairing", store, now: clock.now, random: seq([0.1]) })
    expect((await access.approve("NOPE2345", "owner")).ok).toBe(false)

    await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })
    const [pending] = await access.listPending("telegram")
    clock.advance(2 * 60 * 60 * 1000)
    expect((await access.approve(pending.code, "owner")).ok).toBe(false)
  })
})

describe("DM policy variants", () => {
  test("disabled drops all DMs; open allows all", async () => {
    const disabled = createChannelAccess({ dmPolicy: "disabled", store: createMemoryChannelAccessStore() })
    const d = await disabled.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })
    expect(d).toMatchObject({ admission: "drop", reason: "dm_disabled" })

    const open = createChannelAccess({ dmPolicy: "open", store: createMemoryChannelAccessStore() })
    expect((await open.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })).admission).toBe("allow")
  })

  test("allowlist admits only seeded senders, no pairing offer", async () => {
    const access = createChannelAccess({
      dmPolicy: "allowlist",
      store: createMemoryChannelAccessStore(),
      allowFrom: ["telegram:owner"],
    })
    expect((await access.gate({ channel: "telegram", externalUserId: "owner", chatType: "dm" })).admission).toBe("allow")
    const denied = await access.gate({ channel: "telegram", externalUserId: "stranger", chatType: "dm" })
    expect(denied).toMatchObject({ admission: "drop", reason: "dm_not_allowlisted" })
  })
})

describe("group policy + chatType", () => {
  test("group allowlist is independent of DM pairing", async () => {
    const access = createChannelAccess({
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      store: createMemoryChannelAccessStore(),
      allowFrom: ["telegram:teammember"],
    })
    // In a group, the allowlisted member is admitted...
    expect((await access.gate({ channel: "telegram", externalUserId: "teammember", chatType: "group" })).admission).toBe("allow")
    // ...a non-member is dropped (not offered pairing — that's DM-only).
    const denied = await access.gate({ channel: "telegram", externalUserId: "rando", chatType: "group" })
    expect(denied).toMatchObject({ admission: "drop", reason: "group_not_allowlisted" })
  })

  test("missing chatType defaults to the stricter DM surface", async () => {
    const access = createChannelAccess({ dmPolicy: "pairing", store: createMemoryChannelAccessStore(), random: seq([0.1]) })
    const d = await access.gate({ channel: "telegram", externalUserId: "42" })
    expect(d).toMatchObject({ admission: "drop", reason: "dm_pairing_required" })
  })

  test("blocked identity is refused on both surfaces before any policy", async () => {
    const bindings = createMemoryChannelIdentityBindingStore()
    await bindings.put({ channel: "telegram", externalUserId: "42", accountId: null, status: "blocked", boundAt: 1 })
    const access = createChannelAccess({ dmPolicy: "open", groupPolicy: "open", store: createMemoryChannelAccessStore(), bindings })
    expect(await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })).toMatchObject({ admission: "drop", reason: "identity_blocked" })
    expect(await access.gate({ channel: "telegram", externalUserId: "42", chatType: "group" })).toMatchObject({ admission: "drop", reason: "identity_blocked" })
  })
})
