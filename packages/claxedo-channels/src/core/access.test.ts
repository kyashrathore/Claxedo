import { describe, expect, test, vi } from "vitest"
import {
  createChannelAccess,
  createMemoryChannelAccessStore,
  createMemoryChannelIdentityBindingStore,
  generatePairingCode,
  parseDmPolicy,
  parseGroupEngagement,
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

  test("the default source draws every alphabet symbol, no repeats across a batch", () => {
    const codes = Array.from({ length: 200 }, () => generatePairingCode())
    expect(codes.filter((code) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code))).toHaveLength(200)
    // A stuck/constant source, or one that reaches only part of the alphabet,
    // shows up here: 1600 draws leave a reachable symbol unseen with
    // probability ~1e-22, so this is a structural claim, not a coin flip.
    expect(new Set(codes).size).toBe(200)
    expect(new Set(codes.join("")).size).toBe("ABCDEFGHJKLMNPQRSTUVWXYZ23456789".length)
  })

  test("the default source is the CSPRNG, not Math.random", () => {
    // The only in-process way to assert the *source*: entropy quality is not
    // observable from output, so pin that the predictable generator is untouched.
    // Reverting the default to Math.random fails this and nothing else.
    const spy = vi.spyOn(Math, "random")
    generatePairingCode()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
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

  test("authenticated claim persists the canonical binding before consuming the pairing code", async () => {
    const store = createMemoryChannelAccessStore()
    const bindings = createMemoryChannelIdentityBindingStore()
    const clock = fixedClock()
    const access = createChannelAccess({ dmPolicy: "pairing", store, bindings, now: clock.now, random: seq([0.1]) })

    await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })
    const [pending] = await access.listPending("telegram")
    const bind = vi.fn()
      .mockRejectedValueOnce(new Error("canonical authority unavailable"))
      .mockResolvedValueOnce({ accountId: "user_canonical", boundBy: "actor:actor_canonical" })

    await expect(access.approve(pending.code, "authenticated-claim", bind)).rejects.toThrow(
      "canonical authority unavailable",
    )
    expect(await access.listPending("telegram")).toEqual([pending])
    expect(await bindings.get("telegram", "42")).toBeUndefined()

    await expect(access.approve(pending.code, "authenticated-claim", bind)).resolves.toEqual({
      ok: true,
      channel: "telegram",
      externalUserId: "42",
    })
    expect(await access.listPending("telegram")).toEqual([])
    expect(await bindings.get("telegram", "42")).toMatchObject({
      status: "bound",
      accountId: "user_canonical",
      boundBy: "actor:actor_canonical",
    })
    expect((await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })).admission).toBe("allow")

    await access.revoke("telegram", "42")
    await access.revoke("telegram", "42")
    expect(await bindings.get("telegram", "42")).toBeUndefined()
    expect(await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })).toMatchObject({
      admission: "drop",
      reason: "dm_pairing_required",
    })
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
      groupEngagement: "unprompted",
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

  test("group access is deny-by-default when no policy is configured", async () => {
    // A group is a room full of people nobody approved individually, so the
    // absent-config value must be allowlist, never "open".
    const access = createChannelAccess({ dmPolicy: "open", store: createMemoryChannelAccessStore() })
    expect(access.groupPolicy).toBe("allowlist")
    expect(await access.gate({
      channel: "telegram",
      externalUserId: "rando",
      chatType: "group",
      mentions: ["@bot"],
    })).toMatchObject({ admission: "drop", reason: "group_not_allowlisted" })
  })

  test("mention mode ignores group messages that do not address the bot", async () => {
    const access = createChannelAccess({
      dmPolicy: "open",
      groupPolicy: "open",
      store: createMemoryChannelAccessStore(),
      allowFrom: ["telegram:teammember"],
    })
    expect(access.groupEngagement).toBe("mention")
    // Addressed → engaged, even though the room is busy.
    expect((await access.gate({
      channel: "telegram",
      externalUserId: "teammember",
      chatType: "group",
      mentions: ["@claxedo"],
    })).admission).toBe("allow")
    // Not addressed → not a request at all. Distinct from a policy denial: the
    // sender is welcome, they just were not talking to the bot.
    expect(await access.gate({
      channel: "telegram",
      externalUserId: "teammember",
      chatType: "group",
    })).toMatchObject({ admission: "drop", reason: "group_not_addressed" })
    expect(await access.gate({
      channel: "telegram",
      externalUserId: "teammember",
      chatType: "group",
      mentions: [],
    })).toMatchObject({ admission: "drop", reason: "group_not_addressed" })
  })

  test("unprompted mode engages every admitted group sender", async () => {
    const access = createChannelAccess({
      dmPolicy: "open",
      groupPolicy: "allowlist",
      groupEngagement: "unprompted",
      store: createMemoryChannelAccessStore(),
      allowFrom: ["telegram:teammember"],
    })
    expect((await access.gate({
      channel: "telegram",
      externalUserId: "teammember",
      chatType: "group",
    })).admission).toBe("allow")
    // Engagement is not access: an unallowlisted sender is still refused.
    expect(await access.gate({
      channel: "telegram",
      externalUserId: "rando",
      chatType: "group",
    })).toMatchObject({ admission: "drop", reason: "group_not_allowlisted" })
  })

  test("mention gating never applies to DMs", async () => {
    // A DM is addressed to the bot by construction — there is nobody else in it.
    const access = createChannelAccess({ dmPolicy: "open", store: createMemoryChannelAccessStore() })
    expect((await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })).admission).toBe("allow")
  })

  test("a disabled group surface refuses before the engagement check", async () => {
    // "disabled" means the operator turned groups off; an addressed message is
    // still refused, and the reason names the policy rather than the mention.
    const access = createChannelAccess({
      dmPolicy: "open",
      groupPolicy: "disabled",
      store: createMemoryChannelAccessStore(),
      allowFrom: ["*"],
    })
    expect(await access.gate({
      channel: "telegram",
      externalUserId: "teammember",
      chatType: "group",
      mentions: ["@claxedo"],
    })).toMatchObject({ admission: "drop", reason: "group_disabled" })
  })

  test("parseGroupEngagement defaults to mention on absent or unknown input", () => {
    expect(parseGroupEngagement("unprompted")).toBe("unprompted")
    expect(parseGroupEngagement("MENTION")).toBe("mention")
    expect(parseGroupEngagement(undefined)).toBe("mention")
    // A config typo must land on the quieter mode, not the louder one.
    expect(parseGroupEngagement("always")).toBe("mention")
    expect(parseGroupEngagement("")).toBe("mention")
  })

  test("blocked identity is refused on both surfaces before any policy", async () => {
    const bindings = createMemoryChannelIdentityBindingStore()
    await bindings.put({ channel: "telegram", externalUserId: "42", accountId: null, status: "blocked", boundAt: 1 })
    const access = createChannelAccess({ dmPolicy: "open", groupPolicy: "open", store: createMemoryChannelAccessStore(), bindings })
    expect(await access.gate({ channel: "telegram", externalUserId: "42", chatType: "dm" })).toMatchObject({ admission: "drop", reason: "identity_blocked" })
    expect(await access.gate({ channel: "telegram", externalUserId: "42", chatType: "group" })).toMatchObject({ admission: "drop", reason: "identity_blocked" })
  })
})
