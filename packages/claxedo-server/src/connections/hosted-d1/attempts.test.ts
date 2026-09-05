import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

import {
  createD1ConnectionAttempts,
  HOSTED_ATTEMPT_RETENTION_MS,
  HOSTED_ATTEMPT_TTL_MS,
} from "./attempts"

/**
 * These are the SEMANTICS tests the kit's in-memory store pins
 * (packages/claxedo-connections/src/attempts.ts), run against the real D1
 * table: single-use atomic consume, non-consuming peek that records expiry,
 * expire distinct from settle(false), and a mid-consume row that outlives its
 * TTL. Both stores implement one port and must answer alike.
 */
const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  const path = fileURLToPath(new URL("../../../migrations/control-plane/0020_hosted_connections.sql", import.meta.url))
  const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
  for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
    await target.prepare(statement).run()
  }
  return target
}

/** A store over a clock the test moves, so TTL arithmetic is exact rather than timed. */
async function store(options: { newToken?: () => string } = {}) {
  const target = await database()
  let clock = 1_000_000
  const attempts = createD1ConnectionAttempts({
    database: target,
    now: () => clock,
    ...(options.newToken ? { newToken: options.newToken } : {}),
  })
  return {
    attempts,
    database: target,
    advance: (ms: number) => {
      clock += ms
    },
    at: () => clock,
  }
}

describe("D1 hosted connection attempts", () => {
  test("an attempt created by one store instance is found by another — the durability the in-memory store cannot give", async () => {
    const rig = await store()
    const { state } = await rig.attempts.create({ integrationId: "context7", scope: "team", owner: "org:org-a" })

    // A second store over the same database stands in for the next request's
    // isolate, which is where the in-memory map went empty.
    const next = createD1ConnectionAttempts({ database: rig.database, now: rig.at })
    expect(await next.status(state)).toEqual({ status: "pending", integrationId: "context7", scope: "team" })
    expect(await next.inspect(state)).toEqual({ integrationId: "context7", owner: "org:org-a", scope: "team" })
  })

  test("consume is single-use and hands back the verifier and frozen context exactly once", async () => {
    const rig = await store()
    const { state, verifier } = await rig.attempts.create({
      integrationId: "mcp-docs",
      scope: "personal",
      owner: "user:user-1",
      context: { issuer: "https://mcp-issuer.example" },
      routing: { org_id: "org-a", owner_user_id: "user-1" },
    })

    expect(await rig.attempts.consume(state)).toEqual({
      integrationId: "mcp-docs",
      owner: "user:user-1",
      scope: "personal",
      verifier,
      context: { issuer: "https://mcp-issuer.example" },
    })
    expect(await rig.attempts.consume(state)).toBeUndefined()
    // A mid-consume row is invisible to callback routing: only `settle` may move it.
    expect(await rig.attempts.inspect(state)).toBeUndefined()
    expect(await rig.attempts.consume("never-issued")).toBeUndefined()
  })

  test("inspect carries the frozen routing and context but never the verifier", async () => {
    const rig = await store()
    const { state, verifier } = await rig.attempts.create({
      integrationId: "mcp-docs",
      scope: "team",
      owner: "org:org-a",
      context: { issuer: "https://mcp-issuer.example" },
      routing: { org_id: "org-a", owner_user_id: "user-1" },
    })

    const routing = await rig.attempts.inspect(state)
    expect(routing).toEqual({
      integrationId: "mcp-docs",
      owner: "org:org-a",
      scope: "team",
      routing: { org_id: "org-a", owner_user_id: "user-1" },
      context: { issuer: "https://mcp-issuer.example" },
    })
    expect(JSON.stringify(routing)).not.toContain(verifier)
  })

  test("peek is non-consuming for device grants and RECORDS the expiry it observes", async () => {
    const rig = await store()
    const { state } = await rig.attempts.create({
      integrationId: "github",
      scope: "team",
      owner: "org:org-a",
      deviceCode: "device-1",
    })
    const device = { integrationId: "github", owner: "org:org-a", scope: "team", deviceCode: "device-1" }

    // Many polls, same answer — `consume` cannot serve this, being single-use.
    expect(await rig.attempts.peek(state)).toEqual(device)
    expect(await rig.attempts.peek(state)).toEqual(device)

    rig.advance(HOSTED_ATTEMPT_TTL_MS)
    expect(await rig.attempts.peek(state)).toBeUndefined()
    // Recorded, not merely derived: without the write a timed-out device attempt
    // would keep reading pending and the client would poll to its own cap.
    const row = await rig.database
      .prepare(`select status, expires_at from hosted_connection_attempts where state = ?`)
      .bind(state)
      .first<{ status: string; expires_at: number }>()
    expect(row).toEqual({ status: "expired", expires_at: rig.at() + HOSTED_ATTEMPT_RETENTION_MS })
    expect(await rig.attempts.status(state)).toEqual({ status: "expired", integrationId: "github", scope: "team" })
  })

  test("a redirect attempt has no device code, so peek never answers for it", async () => {
    const rig = await store()
    const { state } = await rig.attempts.create({ integrationId: "context7", scope: "team" })
    expect(await rig.attempts.peek(state)).toBeUndefined()
  })

  test("a pending attempt past its TTL is not consumable and reads as expired", async () => {
    const rig = await store()
    const { state } = await rig.attempts.create({ integrationId: "context7", scope: "team" })

    rig.advance(HOSTED_ATTEMPT_TTL_MS)
    expect(await rig.attempts.inspect(state)).toBeUndefined()
    expect(await rig.attempts.consume(state)).toBeUndefined()
    expect(await rig.attempts.status(state)).toEqual({ status: "expired", integrationId: "context7", scope: "team" })
    // The refused consume recorded the expiry rather than leaving it derived.
    expect(
      (await rig.database
        .prepare(`select status from hosted_connection_attempts where state = ?`)
        .bind(state)
        .first<{ status: string }>())?.status,
    ).toBe("expired")
  })

  test("a mid-consume attempt is left pending past its TTL — only settle may move it", async () => {
    const rig = await store()
    const { state } = await rig.attempts.create({ integrationId: "context7", scope: "team" })
    expect(await rig.attempts.consume(state)).toBeDefined()

    // A slow token exchange still owns its attempt.
    rig.advance(HOSTED_ATTEMPT_TTL_MS * 2)
    await rig.attempts.sweep()
    expect(await rig.attempts.status(state)).toMatchObject({ status: "pending" })

    await rig.attempts.settle(state, true)
    expect(await rig.attempts.status(state)).toEqual({ status: "complete", integrationId: "context7", scope: "team" })
  })

  test("settle records complete and failed, and a message only when there is one", async () => {
    const rig = await store()
    const complete = await rig.attempts.create({ integrationId: "context7", scope: "team" })
    const failed = await rig.attempts.create({ integrationId: "github", scope: "personal", owner: "user:user-1" })

    await rig.attempts.settle(complete.state, true)
    await rig.attempts.settle(failed.state, false, "callback_failed")

    expect(await rig.attempts.status(complete.state)).toEqual({
      status: "complete",
      integrationId: "context7",
      scope: "team",
    })
    expect(await rig.attempts.status(failed.state)).toEqual({
      status: "failed",
      integrationId: "github",
      scope: "personal",
      message: "callback_failed",
    })

    // Terminal rows are never re-settled.
    await rig.attempts.settle(complete.state, false, "too late")
    expect(await rig.attempts.status(complete.state)).toMatchObject({ status: "complete" })
  })

  test("expire is its own outcome, distinct from settle(false)", async () => {
    const rig = await store()
    const { state } = await rig.attempts.create({ integrationId: "github", scope: "team", deviceCode: "device-1" })

    await rig.attempts.expire(state)

    // "expired" is worth restarting; "failed" reads as a refusal. Collapsing the
    // two would tell a user who merely took too long that authorization was denied.
    expect(await rig.attempts.status(state)).toEqual({ status: "expired", integrationId: "github", scope: "team" })
    expect(await rig.attempts.peek(state)).toBeUndefined()
    expect(await rig.attempts.consume(state)).toBeUndefined()
  })

  test("sweep deletes terminal rows past retention and expires stale pending ones", async () => {
    const rig = await store()
    const stale = await rig.attempts.create({ integrationId: "context7", scope: "team" })
    const settled = await rig.attempts.create({ integrationId: "github", scope: "team" })
    await rig.attempts.settle(settled.state, true)

    // Retention (5 min) is shorter than the TTL (10 min), so a settled attempt
    // always ages out before a pending one does.
    rig.advance(HOSTED_ATTEMPT_RETENTION_MS)
    await rig.attempts.sweep()
    expect(await rig.attempts.status(settled.state)).toBeUndefined()
    expect(await rig.attempts.status(stale.state)).toMatchObject({ status: "pending" })

    rig.advance(HOSTED_ATTEMPT_TTL_MS - HOSTED_ATTEMPT_RETENTION_MS)
    await rig.attempts.sweep()
    // Expired, not deleted: a client that polls once more still learns why its
    // attempt ended.
    expect(await rig.attempts.status(stale.state)).toEqual({
      status: "expired",
      integrationId: "context7",
      scope: "team",
    })

    rig.advance(HOSTED_ATTEMPT_RETENTION_MS)
    await rig.attempts.sweep()
    expect(await rig.attempts.status(stale.state)).toBeUndefined()
  })

  test("concurrent consumers of one attempt: exactly one wins", async () => {
    // The sequential single-use test above cannot see this: it consumes after
    // the first consume already returned. Two isolates racing the SAME callback
    // both read a pending row before either writes, so only an atomic claim
    // keeps them from both settling the attempt — and only one of them may
    // receive the verifier that redeems the authorization code.
    const rig = await store()
    const { state, verifier } = await rig.attempts.create({
      integrationId: "composio",
      owner: "user:user-1",
      scope: "personal",
    })

    const claims = await Promise.all(Array.from({ length: 5 }, () => rig.attempts.consume(state)))

    const winners = claims.filter((claim) => claim !== undefined)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({ integrationId: "composio", owner: "user:user-1", verifier })
    // The losers did not move the attempt either: it is mid-consume, so only
    // `settle` may finish it.
    expect(await rig.attempts.status(state)).toMatchObject({ status: "pending" })
    await rig.attempts.settle(state, true)
    expect(await rig.attempts.status(state)).toMatchObject({ status: "complete" })
  })

  test("ownership answers for a terminal row, which inspect deliberately does not", async () => {
    // This is the read the hosted poll gate authorizes against. `inspect` stops
    // answering the moment the attempt settles, but the owner still polls after
    // that — so gating on `inspect` would 404 the legitimate owner.
    const rig = await store()
    const { state } = await rig.attempts.create({
      integrationId: "composio",
      owner: "org:org-a",
      scope: "team",
      routing: { org_id: "org-a", owner_user_id: "user-1" },
    })

    expect(await rig.attempts.ownership(state)).toEqual({
      owner: "org:org-a",
      routing: { org_id: "org-a", owner_user_id: "user-1" },
    })
    await rig.attempts.settle(state, true)
    expect(await rig.attempts.inspect(state)).toBeUndefined()
    expect(await rig.attempts.ownership(state)).toEqual({
      owner: "org:org-a",
      routing: { org_id: "org-a", owner_user_id: "user-1" },
    })
    expect(await rig.attempts.ownership("not-an-attempt")).toBeUndefined()
  })

  test("a duplicate state is refused rather than shadowing the first attempt", async () => {
    // `state` is 32 random bytes; a collision is either a bug or a replay, and
    // either way the second write must not overwrite a live attempt.
    const rig = await store({ newToken: () => "collision" })
    await rig.attempts.create({ integrationId: "context7", scope: "team" })
    await expect(rig.attempts.create({ integrationId: "github", scope: "team" }))
      .rejects.toThrow(/already recorded/)
    expect(await rig.attempts.status("collision")).toMatchObject({ integrationId: "context7" })
  })

  test("dispose destroys nothing — the hosted setup calls it after EVERY request", async () => {
    // This is the regression that would restore the original bug in a new shape:
    // if dispose deleted rows, the attempt created by `POST /:id/connect` would
    // be gone before `GET /attempts/:state` ran.
    const rig = await store()
    const { state } = await rig.attempts.create({ integrationId: "context7", scope: "team" })

    rig.attempts.dispose()

    expect(await rig.attempts.status(state)).toMatchObject({ status: "pending" })
  })

  test("state and verifier are unpredictable by default", async () => {
    // The default token source is Web Crypto; a weak or repeating state would
    // let one user's callback settle another's attempt.
    const rig = await store()
    const attempts = createD1ConnectionAttempts({ database: rig.database })
    const seen = new Set<string>()
    for (let index = 0; index < 5; index++) {
      const { state, verifier } = await attempts.create({ integrationId: "context7", scope: "team" })
      expect(state).not.toEqual(verifier)
      // 32 bytes base64url, matching what the kit's in-memory store mints.
      expect(state.length).toBeGreaterThanOrEqual(43)
      seen.add(state)
    }
    expect(seen.size).toBe(5)
  })
})
