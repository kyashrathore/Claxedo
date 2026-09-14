/**
 * A real `claxedo connect` host against the real control plane and relay:
 * `claxedo host …` from this process as the owner, `claxedo connect` children
 * spawned by the fixture as the machine, the relay child asking the control
 * plane for targets, revocation and serving generations. No embedded host,
 * no browser: every assertion is against processes and their routes.
 *
 * The ten items run in one serial describe because they are ten steps in the
 * life of one machine — an enrollment the later items supersede, revoke and
 * retire — so a failure stops the rest rather than letting them assert on a
 * machine in an unknown state.
 *
 * Timing bounds are the configured ones (`TIMING` and the CLI's own beat
 * interval), never "eventually": each wait records how long it took and
 * asserts against the bound it derives from.
 */
import { expect, test } from "@playwright/test"
import path from "node:path"
import { startScriptedModelServer, type ScriptedModelServer } from "../helpers/scripted-model-server"
import { APP_DIR } from "../helpers/web-signed-relay-harness"
import {
  connect,
  errorCode,
  faults,
  hostGeneration,
  hostTunnelAdmission,
  invitationTokenFrom,
  machines,
  mintConnection,
  mintHtt,
  mintRht,
  openEventStream,
  ownerCli,
  ownerHome,
  relayAudit,
  relayFetch,
  relayHostPresence,
  relayTarget,
  sleep,
  startConnectHostFixture,
  teammate,
  tunnelDeliver,
  until,
  userHostedWorkspaces,
  type RelayTiming,
  type RunningConnectFixture,
  type Teammate,
} from "../helpers/connect-host-fixture"
import { Identifier } from "../../src/lib/id"

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const BACKEND_PORT = Number(process.env.CLAXEDO_REAL_CONNECT_HOST_BACKEND_PORT ?? 4583)

/**
 * `packages/cli/src/connect/host.ts`: `BEAT_INTERVAL_MS = min(LEASE_TTL_MS / 3, 20_000)`
 * with a 60 s lease. The host learns an assignment, a scope change or a
 * revocation on its next beat, so "within N beats" is N × this.
 */
const BEAT_INTERVAL_MS = 20_000
const LEASE_TTL_MS = 60_000
/** `@claxedo/workspace-relay-protocol` `SESSION_STREAM_LEASE_TTL_MS`: a private-session stream renews inside this. */
const STREAM_LEASE_TTL_MS = 15_000
/** Scheduling slack on every bound; the bound itself is the configured value. */
const SLACK_MS = 3_000

const TIMING: RelayTiming = {
  revocationCacheTtlMs: 10_000,
  hostGenerationCacheTtlMs: 10_000,
  targetCacheTtlMs: 5_000,
  clientCheckIntervalMs: 10_000,
  hostGenerationCheckIntervalMs: 10_000,
}

const SCRIPTED_MODEL = { providerID: "pi", modelID: "openai/gpt-4" } as const

let scripted: ScriptedModelServer
let fixture: RunningConnectFixture
let owner: string

/** What the items hand each other: the machine, its workspaces, its people. */
const state: {
  invitation?: string
  enrollmentId?: string
  hostId?: string
  host: string
  wsApi?: string
  wsWeb?: string
  sessionA?: string
  sessionB?: string
  bob?: Teammate
} = { host: "primary" }

function require<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`GATING: an earlier item did not produce ${what}`)
  return value
}

/** Measured bounds, printed so a run's report carries the numbers, not only the pass. */
function timing(label: string, values: Record<string, number | string | undefined>) {
  console.log(`[real-connect-host timing] ${label}: ${JSON.stringify(values)}`)
}

const byText = (a: string | undefined, b: string | undefined) => String(a).localeCompare(String(b))
const byFirst = (a: unknown[], b: unknown[]) => byText(String(a[0]), String(b[0]))

async function cli(...args: string[]) {
  return await ownerCli(fixture, args, { home: owner })
}

/** `claxedo host assign` names the workspace id it created or reused. */
function assignedWorkspaceId(output: string) {
  const match = /as (ws_[0-9a-f]+)/.exec(output)
  if (!match) throw new Error(`GATING: assign output names no workspace: ${output}`)
  return match[1]
}

/**
 * The three routability readers the plan says must agree at every step: the
 * catalog's `host_online`, the connection mint (`activeWorkspaceHost`), and
 * the relay's target lookup. All three read the readiness table through the
 * one serving predicate; this is what "agree" means here.
 */
async function routability(workspaceId: string, hostId: string) {
  const [catalog, mint, target] = await Promise.all([
    userHostedWorkspaces(fixture),
    mintConnection(fixture, workspaceId),
    relayTarget(fixture, workspaceId, hostId),
  ])
  const row = catalog.find((item) => item.workspace_id === workspaceId)
  return {
    listed: row !== undefined,
    hostOnline: row?.host_online === true,
    mintable: mint.ok,
    mintCode: mint.ok ? undefined : errorCode(mint.body),
    relayTarget: target.found,
  }
}

function expectAgreement(view: Awaited<ReturnType<typeof routability>>, expected: boolean, label: string) {
  expect(view, `${label}: routability readers disagree or differ from ${expected}: ${JSON.stringify(view)}`).toMatchObject({
    hostOnline: expected,
    mintable: expected,
    relayTarget: expected,
  })
}

async function servedByHost(instance: string, workspaceId: string) {
  const status = await connect.status(fixture, instance)
  return status.state?.run?.served?.find((row) => row.workspace_id === workspaceId)
}

/** Reserve at the control plane, then create through the relay on the external host. */
async function createSessionThroughHost(workspaceId: string, title: string) {
  const sessionId = Identifier.ascending("session")
  const operationId = `op_connect_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const reserved = await fetch(`${fixture.info.backendUrl}/api/control/session-registrations/reserve`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixture.info.controlPlaneToken}`, "content-type": "application/json" },
    body: JSON.stringify({ operationId, sessionId, workspaceId, kind: "create", title }),
  })
  expect(reserved.status, `reserve ${title}: ${await reserved.clone().text()}`).toBe(201)
  const connection = await mintConnection(fixture, workspaceId)
  expect(connection.ok, `owner mint for ${workspaceId}: ${connection.text}`).toBe(true)
  const created = await relayFetch(fixture.info.relayUrl, workspaceId, connection.body!.runtimeAccessToken, "/session?nativeHarness=pi", {
    method: "POST",
    headers: { "x-claxedo-session-registration-operation": operationId },
    body: { id: sessionId, title },
  })
  expect(created.status, `create ${title} through the host: ${created.text}`).toBe(201)
  return sessionId
}

async function controlSessions(token: string, workspaceId: string) {
  const url = new URL(`${fixture.info.backendUrl}/api/control/sessions`)
  url.searchParams.set("workspaceId", workspaceId)
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } })
  const text = await response.text()
  expect(response.ok, `session list: ${response.status} ${text}`).toBe(true)
  return ((JSON.parse(text) as { sessions?: Array<{ session_id?: string }> }).sessions ?? []).map((row) => row.session_id)
}

test.describe.configure({ mode: "serial" })

test.describe("real claxedo connect host @core @tier-real", () => {
  test.skip(!TIER_REAL, "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run a real `claxedo connect` host against the real control plane and relay. Requires node, bun, git and lsof on PATH.")

  test.beforeAll(async () => {
    if (!TIER_REAL) return
    test.setTimeout(180_000)
    scripted = await startScriptedModelServer()
    fixture = await startConnectHostFixture({
      backendPort: BACKEND_PORT,
      scripted,
      claudeConfigDir: path.join(APP_DIR, "..", "..", "node_modules", ".cache", "real-connect-host-claude"),
      timing: TIMING,
    })
    owner = await ownerHome()
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    await Promise.allSettled([fixture?.close(), scripted?.close()])
  })

  test.afterEach(async () => {
    const info = test.info()
    if (!TIER_REAL || info.status === info.expectedStatus) return
    const primary = await connect.status(fixture, state.host).catch(() => undefined)
    console.log(
      `\n[real-connect-host] after "${info.title}" (${info.status}):\n` +
        `--- ${state.host} log tail ---\n${primary?.log.slice(-3000) ?? "(no instance)"}\n` +
        `--- fixture log tail ---\n${fixture.log().slice(-3000)}`,
    )
  })

  test("1. fresh enrollment: redeem, no assignments, owner assigns, host acks within two beats, tunnel up, catalog online", async () => {
    test.setTimeout(150_000)
    const roots = fixture.info.roots

    const before = await cli("host", "list")
    expect(before.code, before.output).toBe(0)
    expect(before.stdout).toContain("No machines are enrolled")

    const invite = await cli("host", "invite", "--name", "box1", "--root", roots.root)
    expect(invite.code, invite.output).toBe(0)
    state.invitation = invitationTokenFrom(invite.stdout)

    await connect.start(fixture, { id: "primary", token: state.invitation, roots: [roots.root], name: "box1" })
    const enrolled = await until(
      async () => {
        const status = await connect.status(fixture, "primary")
        if (status.exit) throw new Error(`connect exited ${JSON.stringify(status.exit)}:\n${status.log}`)
        return status.state?.enrollment && status.state.run?.last_beat_ok_at ? status : undefined
      },
      { timeoutMs: 60_000, message: "the host never enrolled and beat" },
    )
    state.enrollmentId = enrolled.value.state!.enrollment!.enrollment_id
    state.hostId = enrolled.value.state!.host_id
    expect(enrolled.value.log).toContain(`Enrolled as ${state.enrollmentId}`)
    // Enrolled, and nothing to serve: the invitation grants roots, not folders.
    expect(enrolled.value.state!.run!.served).toEqual([])
    expect(await userHostedWorkspaces(fixture)).toEqual([])
    const listed = await machines(fixture)
    expect(listed.map((machine) => [machine.display_name, machine.enrollment_id, machine.host_id])).toEqual([["box1", state.enrollmentId, state.hostId]])
    expect(listed[0].scope?.allowed_roots).toEqual([roots.root])

    const assign = await cli("host", "assign", "--machine", "box1", roots.api)
    expect(assign.code, assign.output).toBe(0)
    state.wsApi = assignedWorkspaceId(assign.stdout)
    const assignedAt = Date.now()
    // Assigned but not yet acked: every reader says offline together.
    expectAgreement(await routability(state.wsApi, state.hostId), false, "assigned, not acked")

    // The host learns the assignment on its next beat and acks on the one
    // after; the tunnel the relay holds is the observation, the state file's
    // served row (rewritten on each renewal) the host's own record of it.
    const served = await until(
      async () => {
        const [row, presence] = await Promise.all([servedByHost("primary", state.wsApi!), relayHostPresence(fixture, state.hostId!, state.wsApi!)])
        return row && presence.active ? { row, presence } : undefined
      },
      { timeoutMs: 2 * BEAT_INTERVAL_MS + SLACK_MS, message: "the host never acked the assignment and opened its tunnel" },
    )
    expect(served.elapsedMs, "ack + tunnel took longer than two beats").toBeLessThanOrEqual(2 * BEAT_INTERVAL_MS + SLACK_MS)
    timing("item 1 assign → ack + tunnel", { elapsedMs: served.elapsedMs, boundMs: 2 * BEAT_INTERVAL_MS + SLACK_MS })
    expect(served.value.row.revision).toBe(1)
    expect(served.value.presence.presence!.connectedAt).toBeGreaterThanOrEqual(assignedAt)
    expectAgreement(await routability(state.wsApi, state.hostId), true, "acked")
    const catalog = await userHostedWorkspaces(fixture)
    expect(catalog.map((row) => [row.workspace_id, row.remote_directory, row.host_online])).toEqual([[state.wsApi, roots.api, true]])

    // The owner reaches the folder through the relay and the external host,
    // with a product-minted token, without sharing anything with themself.
    const connection = await mintConnection(fixture, state.wsApi)
    expect(connection.body?.role).toBe("owner")
    const file = await relayFetch(fixture.info.relayUrl, state.wsApi, connection.body!.runtimeAccessToken, "/file/content?path=hello.txt")
    expect(file.status, file.text).toBe(200)
    expect(String(file.json?.content)).toContain("hello from api through claxedo connect")
  })

  test("2. the same token with a fresh key → exit 78 invitation_redeemed; the right id with a wrong secret → invitation_invalid without a redeemed-by detail", async () => {
    test.setTimeout(90_000)
    const token = require(state.invitation, "the invitation")

    await connect.start(fixture, { id: "second-key", token, roots: [fixture.info.roots.root], name: "box1-clone" })
    const second = await connect.waitExit(fixture, "second-key", 60_000)
    const secondStatus = await connect.status(fixture, "second-key")
    expect(second.exit?.code, secondStatus.log).toBe(78)
    expect(secondStatus.log).toContain("invitation_redeemed")
    expect(secondStatus.state?.enrollment, "a refused redeem must not persist an enrollment").toBeUndefined()

    const [prefix, invitationId] = token.split(".")
    const wrongSecret = `${prefix}.${invitationId}.${"A".repeat(43)}`
    const redeemsBefore = (await desktopHostRequests()).length
    await connect.start(fixture, { id: "wrong-secret", token: wrongSecret, roots: [fixture.info.roots.root] })
    const wrong = await connect.waitExit(fixture, "wrong-secret", 60_000)
    const wrongStatus = await connect.status(fixture, "wrong-secret")
    expect(wrong.exit?.code, wrongStatus.log).toBe(78)
    expect(wrongStatus.log).toContain("invitation_invalid")
    const redeem = (await desktopHostRequests()).slice(redeemsBefore).find((row) => row.phase === "completed" && row.path.endsWith("/redeem"))
    expect(redeem?.status).toBe(403)
    expect(JSON.stringify(redeem?.body)).not.toContain("redeemed_host_id")
    expect(JSON.stringify(redeem?.body)).not.toContain(require(state.hostId, "the host id"))

    expect((await machines(fixture)).length, "refused redeems must not add machines").toBe(1)
  })

  test("3. kill and restart before the lease expires → acquire, no re-enrollment; a redeem whose answer was lost is recovered by the same key on the next boot", async () => {
    test.setTimeout(150_000)
    const enrollmentId = require(state.enrollmentId, "the enrollment id")
    const before = await connect.status(fixture, "primary")
    const generationBefore = before.state!.run!.generation
    expect(before.state!.run!.lease_expires_at!).toBeGreaterThan(Date.now() + 10_000)

    await connect.kill(fixture, "primary")
    const restartedAt = Date.now()
    await connect.start(fixture, { id: "primary" })
    const restarted = await until(
      async () => {
        const status = await connect.status(fixture, "primary")
        if (status.exit) throw new Error(`restart exited ${JSON.stringify(status.exit)}:\n${status.log}`)
        const run = status.state?.run
        return run && run.generation > generationBefore && run.last_beat_ok_at && run.last_beat_ok_at >= restartedAt ? status : undefined
      },
      { timeoutMs: 30_000, message: "the restarted host never acquired and beat" },
    )
    expect(restarted.elapsedMs, "acquire after restart is immediate, not a re-enrollment").toBeLessThanOrEqual(15_000)
    expect(restarted.value.state!.enrollment!.enrollment_id).toBe(enrollmentId)
    expect(restarted.value.log).not.toContain("Enrolled as")
    expect(restarted.value.log).toContain(`serving as ${enrollmentId} (generation ${generationBefore + 1})`)
    expect((await machines(fixture)).map((machine) => machine.enrollment_id)).toEqual([enrollmentId])
    const reserved = await until(
      async () => (await relayHostPresence(fixture, require(state.hostId, "the host id"), require(state.wsApi, "the api workspace"))).active || undefined,
      { timeoutMs: 2 * BEAT_INTERVAL_MS + SLACK_MS, message: "the restarted host never re-served the api workspace" },
    )
    expect(reserved.elapsedMs).toBeLessThanOrEqual(2 * BEAT_INTERVAL_MS + SLACK_MS)

    // Lost-response recovery, on a second machine so the first stays intact.
    const invite = await cli("host", "invite", "--name", "box2", "--root", fixture.info.roots.root)
    expect(invite.code, invite.output).toBe(0)
    const token2 = invitationTokenFrom(invite.stdout)
    await faults.redeemResponseDrop(fixture, true)
    try {
      await connect.start(fixture, { id: "box2", token: token2, roots: [fixture.info.roots.root], name: "box2" })
      const committed = await until(
        async () => (await faults.state(fixture)).heldRedeems >= 1 || undefined,
        { timeoutMs: 30_000, message: "the redeem never reached the barrier" },
      )
      expect(committed.value).toBe(true)
      // Committed at the control plane while the machine is still waiting.
      expect((await machines(fixture)).map((machine) => machine.display_name).sort()).toEqual(["box1", "box2"])
      await connect.kill(fixture, "box2")
    } finally {
      await faults.redeemResponseDrop(fixture, false)
    }
    const interrupted = await connect.status(fixture, "box2")
    expect(interrupted.state?.enrollment, "the lost answer must leave no enrollment on disk").toBeUndefined()
    expect(interrupted.state?.bootstrap?.invitation_id).toBe(token2.split(".")[1])

    await connect.start(fixture, { id: "box2" })
    const resumed = await until(
      async () => {
        const status = await connect.status(fixture, "box2")
        if (status.exit) throw new Error(`box2 restart exited ${JSON.stringify(status.exit)}:\n${status.log}`)
        return status.state?.enrollment && status.state.run?.last_beat_ok_at ? status : undefined
      },
      { timeoutMs: 30_000, message: "box2 never recovered its enrollment" },
    )
    expect(resumed.value.log).toContain(`Resumed as ${resumed.value.state!.enrollment!.enrollment_id}`)
    expect(resumed.value.state!.bootstrap).toBeUndefined()
    const after = await machines(fixture)
    expect(after.filter((machine) => machine.display_name === "box2").map((machine) => machine.enrollment_id))
      .toEqual([resumed.value.state!.enrollment!.enrollment_id])
    expect(after.length, "exactly one enrollment per machine after recovery").toBe(2)
    await connect.stop(fixture, "box2")
  })

  test("4. a second instance from a copied state dir acquires → the first's next beat is 409 and it exits 78; the relay drops its socket; its old HTT cannot re-admit", async () => {
    test.setTimeout(120_000)
    const enrollmentId = require(state.enrollmentId, "the enrollment id")
    const hostId = require(state.hostId, "the host id")
    const wsApi = require(state.wsApi, "the api workspace")
    const before = await connect.status(fixture, "primary")
    const oldGeneration = before.state!.run!.generation
    const oldPresence = await relayHostPresence(fixture, hostId, wsApi)
    expect(oldPresence.active).toBe(true)

    await connect.cloneState(fixture, "primary", "clone")
    const clonedAt = Date.now()
    await connect.start(fixture, { id: "clone" })
    const superseded = await connect.waitExit(fixture, "primary", 2 * BEAT_INTERVAL_MS + SLACK_MS)
    const primary = await connect.status(fixture, "primary")
    expect(superseded.exit?.code, primary.log).toBe(78)
    expect(primary.log).toContain("enrollment_generation_superseded")
    expect(superseded.exit!.at - clonedAt).toBeLessThanOrEqual(2 * BEAT_INTERVAL_MS + SLACK_MS)

    const generation = await hostGeneration(fixture, enrollmentId)
    expect(generation.body?.generation).toBe(oldGeneration + 1)
    expect((await machines(fixture)).find((machine) => machine.enrollment_id === enrollmentId)?.serving_generation).toBe(oldGeneration + 1)

    // The socket the relay holds for this host is the successor's, not the
    // superseded instance's, within the host check plus its cache of the
    // generation the successor acquired. The successor's own dial replaces
    // the incumbent sooner; the check is the bound either way.
    const bound = TIMING.hostGenerationCheckIntervalMs + TIMING.hostGenerationCacheTtlMs + SLACK_MS
    const replaced = await until(
      async () => {
        const presence = await relayHostPresence(fixture, hostId, wsApi)
        return presence.active && presence.presence!.connectedAt >= clonedAt ? presence : undefined
      },
      { timeoutMs: bound, message: "the relay never replaced the superseded instance's tunnel" },
    )
    expect(replaced.value.presence!.connectedAt - clonedAt).toBeLessThanOrEqual(bound)
    expect(replaced.value.presence!.connectedAt).not.toBe(oldPresence.presence!.connectedAt)
    timing("item 4 clone start → primary exit 78 / successor socket", {
      exitMs: superseded.exit!.at - clonedAt,
      socketReplacedMs: replaced.value.presence!.connectedAt - clonedAt,
      socketBoundMs: bound,
    })

    const stale = await mintHtt(fixture, { enrollmentId, hostId, workspaceId: wsApi, generation: oldGeneration })
    const admission = await hostTunnelAdmission(fixture.info.relayUrl, hostId, wsApi, stale.hostTunnelToken)
    expect(admission.status, admission.body).toBe(403)
    expect(admission.code).toBe("host_generation_superseded")

    state.host = "clone"
    const served = await until(
      async () => (await servedByHost("clone", wsApi))?.revision || undefined,
      { timeoutMs: 2 * BEAT_INTERVAL_MS + SLACK_MS, message: "the successor never acked the api workspace" },
    )
    expect(served.value).toBe(1)
    expectAgreement(await routability(wsApi, hostId), true, "successor serving")
  })

  test("6. Alice creates A and B through the external host; shares A with Bob; Bob lists only A and is refused B on the runtime and its event stream", async () => {
    test.setTimeout(120_000)
    const wsApi = require(state.wsApi, "the api workspace")
    state.sessionA = await createSessionThroughHost(wsApi, "A")
    state.sessionB = await createSessionThroughHost(wsApi, "B")
    // Registered at the authority over HTTP from the host process: the control
    // plane lists them without any client having attached.
    expect((await controlSessions(fixture.info.controlPlaneToken, wsApi)).sort(byText)).toEqual([state.sessionA, state.sessionB].sort(byText))

    state.bob = await teammate(fixture, { subject: "user_bob", role: "editor", name: "Bob", workspaceId: wsApi })
    const shared = await fetch(`${fixture.info.backendUrl}/api/control/sessions/${encodeURIComponent(state.sessionA)}/shares`, {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.info.controlPlaneToken}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: wsApi, grantedToTokenIdentifier: state.bob.tokenIdentifier }),
    })
    expect(shared.status, await shared.clone().text()).toBe(200)

    expect(await controlSessions(state.bob.controlPlaneToken, wsApi)).toEqual([state.sessionA])
    const bobConnection = await mintConnection(fixture, wsApi, state.bob.controlPlaneToken)
    expect(bobConnection.ok, bobConnection.text).toBe(true)
    expect(bobConnection.body?.role).toBe("editor")
    const bobToken = bobConnection.body!.runtimeAccessToken

    const readA = await relayFetch(fixture.info.relayUrl, wsApi, bobToken, `/session/${encodeURIComponent(state.sessionA)}`)
    expect(readA.status, readA.text).toBe(200)
    const readB = await relayFetch(fixture.info.relayUrl, wsApi, bobToken, `/session/${encodeURIComponent(state.sessionB)}`)
    expect(readB.status, readB.text).toBe(403)
    const streamB = await openEventStream(fixture.info.relayUrl, wsApi, bobToken, state.sessionB)
    expect(streamB.status).toBe(403)
    const streamA = await openEventStream(fixture.info.relayUrl, wsApi, bobToken, state.sessionA)
    expect(streamA.status).toBe(200)
    streamA.abort()
  })

  test("5. runtime enforcement: a viewer RHT delivered to the host's write route is refused by the runtime; Bob's editor prompt on A is stored with Bob as author", async () => {
    test.setTimeout(120_000)
    const wsApi = require(state.wsApi, "the api workspace")
    const hostId = require(state.hostId, "the host id")
    const sessionA = require(state.sessionA, "session A")
    const bob = require(state.bob, "Bob")

    const viewer = await mintRht(fixture, { role: "viewer", workspaceId: wsApi, hostId, subject: bob.subject })
    const prompt = { parts: [{ type: "text", text: "viewer write" }] }
    const refused = await tunnelDeliver(fixture, {
      instance: state.host,
      workspaceId: wsApi,
      relayHostToken: viewer.relayHostToken,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionA)}/prompt_async`,
      body: prompt,
    })
    expect(refused.status, refused.text).toBe(403)
    expect(errorCode(refused.json)).toBe("session_write_forbidden")
    // The same delivery with a token the relay did not sign is refused at
    // the stamp, which is what makes the 403 above the runtime's own answer.
    const tampered = await tunnelDeliver(fixture, {
      instance: state.host,
      workspaceId: wsApi,
      relayHostToken: `${viewer.relayHostToken.slice(0, -4)}AAAA`,
      method: "POST",
      path: `/session/${encodeURIComponent(sessionA)}/prompt_async`,
      body: prompt,
    })
    expect(tampered.status, tampered.text).toBe(401)
    expect(errorCode(tampered.json)).toBe("invalid_relay_token")

    const bobConnection = await mintConnection(fixture, wsApi, bob.controlPlaneToken)
    expect(bobConnection.body?.role).toBe("editor")
    const marker = `BOBSAYS-${Date.now().toString(36)}`
    const messageID = Identifier.ascending("message")
    const sent = await relayFetch(fixture.info.relayUrl, wsApi, bobConnection.body!.runtimeAccessToken, `/session/${encodeURIComponent(sessionA)}/prompt_async`, {
      method: "POST",
      body: { messageID, model: SCRIPTED_MODEL, parts: [{ type: "text", text: `Reply with exactly this one token and nothing else: ${marker}` }] },
    })
    expect([200, 202, 204], `Bob's prompt: ${sent.status} ${sent.text}`).toContain(sent.status)

    const alice = await mintConnection(fixture, wsApi)
    const stored = await until(
      async () => {
        const messages = await relayFetch(fixture.info.relayUrl, wsApi, alice.body!.runtimeAccessToken, `/session/${encodeURIComponent(sessionA)}/message`)
        if (!messages.ok || !Array.isArray(messages.json)) return undefined
        const rows = messages.json as Array<{ info?: { id?: string; role?: string; claxedo?: { author?: { id?: string; name?: string } } } }>
        return rows.find((row) => row.info?.id === messageID)?.info
      },
      { timeoutMs: 60_000, message: "Bob's prompt never appeared in session A's messages on the host" },
    )
    expect(stored.value.role).toBe("user")
    expect(stored.value.claxedo?.author?.name).toBe("Bob")
    expect(stored.value.claxedo?.author?.id).toBeTruthy()
    expect(stored.value.claxedo?.author?.id).not.toBe(fixture.info.ownerActor.actor_public_id)
  })

  // Observed: the prompt above is admitted and stored, and the turn Pi runs
  // for it fails with `OpenAI API error (401): Incorrect API key provided:
  // test-key` — Pi reaches api.openai.com, not the scripted endpoint. The
  // host runtime's Pi profile is `<storage_root>/<workspace>/pi/agent`
  // (`agent-sdk-runtime/src/harnesses/pi/agent-dir.ts`), whose `models.json`
  // is written from the runtime's auth projections, and nothing delivers a
  // config snapshot to a `claxedo connect` runtime: `packages/cli/src/connect/host.ts`
  // `prepare()` composes `createHostWorkspaceRuntime` with no `configToken`
  // and no harness config, so `/api/wr/config` is unreachable and the
  // projections stay empty. Provider credentials for connect hosts are out of
  // this slice (`2026-09-14-002-feat-connect-components-and-flows.md`, host
  // runtime section), so this is recorded rather than asserted.
  test.fixme("5b. a turn started on the connect host reaches the model endpoint", async () => {
    const wsApi = require(state.wsApi, "the api workspace")
    const sessionA = require(state.sessionA, "session A")
    const alice = await mintConnection(fixture, wsApi)
    const replied = await until(
      async () => scripted.counts().chat > 0
        ? await relayFetch(fixture.info.relayUrl, wsApi, alice.body!.runtimeAccessToken, `/session/${encodeURIComponent(sessionA)}/message`)
        : undefined,
      { timeoutMs: 60_000, message: "no turn from the connect host reached the scripted model" },
    )
    expect(replied.value.ok).toBe(true)
  })

  test("10. two folders on one enrollment are served at once; re-pointing one leaves the other served; every routability reader tracks the readiness table", async () => {
    test.setTimeout(150_000)
    const hostId = require(state.hostId, "the host id")
    const wsApi = require(state.wsApi, "the api workspace")
    const roots = fixture.info.roots

    const assign = await cli("host", "assign", "--machine", "box1", roots.web)
    expect(assign.code, assign.output).toBe(0)
    state.wsWeb = assignedWorkspaceId(assign.stdout)
    const wsWeb = state.wsWeb
    expectAgreement(await routability(wsWeb, hostId), false, "web assigned, not acked")
    expectAgreement(await routability(wsApi, hostId), true, "api while web is pending")
    const both = await until(
      async () => {
        const [api, web] = await Promise.all([relayHostPresence(fixture, hostId, wsApi), relayHostPresence(fixture, hostId, wsWeb)])
        return api.active && web.active ? { api, web } : undefined
      },
      { timeoutMs: 2 * BEAT_INTERVAL_MS + SLACK_MS, message: "the relay never held both workspace tunnels" },
    )
    expect(both.elapsedMs).toBeLessThanOrEqual(2 * BEAT_INTERVAL_MS + SLACK_MS)
    expectAgreement(await routability(wsWeb, hostId), true, "web acked")
    expectAgreement(await routability(wsApi, hostId), true, "api with web served")
    const webConnection = await mintConnection(fixture, wsWeb)
    const webFile = await relayFetch(fixture.info.relayUrl, wsWeb, webConnection.body!.runtimeAccessToken, "/file/content?path=hello.txt")
    expect(String(webFile.json?.content)).toContain("hello from web")

    // Re-point web to docs: the owner route the CLI's assign uses, with the
    // workspace id the CLI reported. A new revision, so readiness lapses
    // until the host re-acks; api is untouched throughout.
    const repointed = await fetch(`${fixture.info.backendUrl}/api/workspace/${encodeURIComponent(wsWeb)}/host-assignment`, {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.info.controlPlaneToken}`, "content-type": "application/json" },
      body: JSON.stringify({ hostId, remoteDirectory: roots.docs, displayName: "docs" }),
    })
    expect(repointed.status, await repointed.clone().text()).toBe(200)
    expectAgreement(await routability(wsWeb, hostId), false, "web re-pointed, not re-acked")
    expectAgreement(await routability(wsApi, hostId), true, "api during web re-point")
    const reacked = await until(
      async () => {
        const [row, presence] = await Promise.all([servedByHost(state.host, wsWeb), relayHostPresence(fixture, hostId, wsWeb)])
        return row?.revision === 2 && presence.active ? row : undefined
      },
      { timeoutMs: 2 * BEAT_INTERVAL_MS + SLACK_MS, message: "the host never re-acked the re-pointed workspace" },
    )
    expect(reacked.elapsedMs).toBeLessThanOrEqual(2 * BEAT_INTERVAL_MS + SLACK_MS)
    expectAgreement(await routability(wsWeb, hostId), true, "web re-acked at revision 2")
    expectAgreement(await routability(wsApi, hostId), true, "api after web re-point")
    const docsConnection = await mintConnection(fixture, wsWeb)
    const docsFile = await until(
      async () => {
        const file = await relayFetch(fixture.info.relayUrl, wsWeb, docsConnection.body!.runtimeAccessToken, "/file/content?path=hello.txt")
        return file.ok && String(file.json?.content).includes("hello from docs") ? file : undefined
      },
      { timeoutMs: TIMING.targetCacheTtlMs + SLACK_MS, message: "the re-pointed workspace never served the docs folder" },
    )
    expect(docsFile.value.ok).toBe(true)
    const apiFile = await relayFetch(fixture.info.relayUrl, wsApi, (await mintConnection(fixture, wsApi)).body!.runtimeAccessToken, "/file/content?path=hello.txt")
    expect(String(apiFile.json?.content)).toContain("hello from api")
    expect((await userHostedWorkspaces(fixture)).map((row) => [row.workspace_id, row.remote_directory, row.host_online]).sort(byFirst))
      .toEqual([[wsApi, roots.api, true], [wsWeb, roots.docs, true]].sort(byFirst))
  })

  test("8. a two-minute control-plane outage: beats fail transiently, the host tunnel stays, streams fail on their own lease, and the host resumes without re-enrolling", async () => {
    test.setTimeout(300_000)
    const hostId = require(state.hostId, "the host id")
    const wsApi = require(state.wsApi, "the api workspace")
    const sessionA = require(state.sessionA, "session A")
    const bob = require(state.bob, "Bob")
    const enrollmentId = require(state.enrollmentId, "the enrollment id")
    const before = await connect.status(fixture, state.host)
    const generation = before.state!.run!.generation
    const presenceBefore = await relayHostPresence(fixture, hostId, wsApi)
    expect(presenceBefore.active).toBe(true)

    const bobConnection = await mintConnection(fixture, wsApi, bob.controlPlaneToken)
    const stream = await openEventStream(fixture.info.relayUrl, wsApi, bobConnection.body!.runtimeAccessToken, sessionA)
    expect(stream.status).toBe(200)

    await faults.controlPlaneOutage(fixture, true)
    const outageAt = Date.now()
    const OUTAGE_MS = 120_000
    try {
      // The stream's authority lease cannot renew: the runtime closes it
      // within its own lease TTL, which is the lease dictating, not a guess.
      const closed = await stream.closed
      expect(closed.closedAt - outageAt, "the private-session stream outlived its unrenewable lease").toBeLessThanOrEqual(STREAM_LEASE_TTL_MS + SLACK_MS)
      timing("item 8 outage → stream closed", { closedMs: closed.closedAt - outageAt, boundMs: STREAM_LEASE_TTL_MS + SLACK_MS })

      const failing = await until(
        async () => (await connect.status(fixture, state.host)).state?.run?.last_beat_error || undefined,
        { timeoutMs: BEAT_INTERVAL_MS + SLACK_MS, message: "the host never recorded a failing beat" },
      )
      expect(failing.value).toContain("503")
      // The lease the control plane issued expires during the outage, so the
      // catalog and the mint say offline — the relay still holds the tunnel.
      const lapsed = await until(
        async () => {
          const view = await routability(wsApi, hostId)
          return !view.hostOnline ? view : undefined
        },
        { timeoutMs: LEASE_TTL_MS + SLACK_MS, message: "the lease never lapsed at the control plane" },
      )
      expectAgreement(lapsed.value, false, "lease lapsed during outage")

      while (Date.now() - outageAt < OUTAGE_MS) {
        const status = await connect.status(fixture, state.host)
        expect(status.running, `the host process died during the outage:\n${status.log.slice(-2000)}`).toBe(true)
        const presence = await relayHostPresence(fixture, hostId, wsApi)
        expect(presence.active, "the host tunnel dropped during the outage").toBe(true)
        expect(presence.presence!.connectedAt, "the host tunnel reconnected during the outage").toBe(presenceBefore.presence!.connectedAt)
        await sleep(10_000)
      }
    } finally {
      await faults.controlPlaneOutage(fixture, false)
    }
    const recoveredAt = Date.now()
    const recovered = await until(
      async () => {
        const status = await connect.status(fixture, state.host)
        const run = status.state?.run
        return run?.last_beat_ok_at && run.last_beat_ok_at >= recoveredAt ? status : undefined
      },
      { timeoutMs: BEAT_INTERVAL_MS + SLACK_MS, message: "the host never beat again after the outage" },
    )
    expect(recovered.value.state!.run!.generation, "recovery must not re-acquire").toBe(generation)
    expect(recovered.value.state!.enrollment!.enrollment_id).toBe(enrollmentId)
    expect(recovered.value.log).not.toContain("Enrolled as")
    expect(recovered.value.log).not.toContain("Resumed as")
    // box2 from item 3 is still enrolled; the point is that box1 is the same row.
    expect((await machines(fixture)).filter((machine) => machine.display_name === "box1").map((machine) => machine.enrollment_id)).toEqual([enrollmentId])
    const online = await until(
      async () => {
        const view = await routability(wsApi, hostId)
        return view.hostOnline && view.mintable && view.relayTarget ? view : undefined
      },
      { timeoutMs: BEAT_INTERVAL_MS + SLACK_MS, message: "the workspace never came back online after the outage" },
    )
    expectAgreement(online.value, true, "after the outage")
    expect((await relayHostPresence(fixture, hostId, wsApi)).presence!.connectedAt).toBe(presenceBefore.presence!.connectedAt)
  })

  test("9. tightening the roots retires the assignment outside them transactionally; the host unacks on its next beat; the workspace disappears from the catalog", async () => {
    test.setTimeout(120_000)
    const hostId = require(state.hostId, "the host id")
    const wsApi = require(state.wsApi, "the api workspace")
    const wsWeb = require(state.wsWeb, "the web workspace")
    const roots = fixture.info.roots
    expect((await userHostedWorkspaces(fixture)).map((row) => row.workspace_id).sort()).toEqual([wsApi, wsWeb].sort())

    const scope = await cli("host", "scope", "--machine", "box1", "--root", roots.api)
    expect(scope.code, scope.output).toBe(0)
    const scopedAt = Date.now()
    // Transactional: gone from the catalog on the very next read, before any beat.
    expect((await userHostedWorkspaces(fixture)).map((row) => row.workspace_id)).toEqual([wsApi])
    const retired = await routability(wsWeb, hostId)
    expect(retired).toMatchObject({ listed: false, hostOnline: false, mintable: false, relayTarget: false })
    expectAgreement(await routability(wsApi, hostId), true, "api inside the new roots")
    expect((await machines(fixture))[0].scope?.allowed_roots).toEqual([roots.api])

    const unacked = await until(
      async () => {
        const status = await connect.status(fixture, state.host)
        const served = status.state?.run?.served ?? []
        const scopeApplied = status.state?.scope?.allowed_roots.join() === roots.api
        return scopeApplied && !served.some((row) => row.workspace_id === wsWeb) && status.state!.run!.last_beat_ok_at! >= scopedAt ? status : undefined
      },
      { timeoutMs: 2 * BEAT_INTERVAL_MS + SLACK_MS, message: "the host never dropped the retired assignment" },
    )
    expect(unacked.elapsedMs).toBeLessThanOrEqual(2 * BEAT_INTERVAL_MS + SLACK_MS)
    expect(unacked.value.log).toContain(`workspace ${wsWeb}: assignment withdrawn`)
    const webPresence = await until(
      async () => {
        const presence = await relayHostPresence(fixture, hostId, wsWeb)
        return presence.active ? undefined : presence
      },
      { timeoutMs: SLACK_MS, message: "the retired workspace's tunnel stayed open" },
    )
    expect(webPresence.value.active).toBe(false)
    expect((await relayHostPresence(fixture, hostId, wsApi)).active).toBe(true)
    // Expansion the owner did not grant is refused at assignment.
    const outside = await cli("host", "assign", "--machine", "box1", roots.web)
    expect(outside.code).not.toBe(0)
    expect(outside.output).toContain("not under any root this machine may serve")
    expect((await userHostedWorkspaces(fixture)).map((row) => row.workspace_id)).toEqual([wsApi])
  })

  test("7. revoking the machine: new client requests refused within the resolver cache, the open stream and the host socket closed by their next checks, the process exits 78 on its next beat", async () => {
    test.setTimeout(150_000)
    const hostId = require(state.hostId, "the host id")
    const wsApi = require(state.wsApi, "the api workspace")
    const sessionA = require(state.sessionA, "session A")
    const bob = require(state.bob, "Bob")
    const enrollmentId = require(state.enrollmentId, "the enrollment id")
    const generation = (await connect.status(fixture, state.host)).state!.run!.generation

    const alice = await mintConnection(fixture, wsApi)
    const aliceToken = alice.body!.runtimeAccessToken
    const bobConnection = await mintConnection(fixture, wsApi, bob.controlPlaneToken)
    const stream = await openEventStream(fixture.info.relayUrl, wsApi, bobConnection.body!.runtimeAccessToken, sessionA)
    expect(stream.status).toBe(200)
    expect((await relayFetch(fixture.info.relayUrl, wsApi, aliceToken, "/api/wr/health")).status).toBe(200)
    const auditSince = Date.now()

    const revoke = await cli("host", "revoke", "--machine", "box1")
    expect(revoke.code, revoke.output).toBe(0)
    const revokedAt = Date.now()
    expect((await hostGeneration(fixture, enrollmentId)).body?.revoked).toBe(true)
    expect((await machines(fixture)).map((machine) => machine.enrollment_id)).not.toContain(enrollmentId)
    expect(await userHostedWorkspaces(fixture)).toEqual([])

    const refused = await until(
      async () => {
        const health = await relayFetch(fixture.info.relayUrl, wsApi, aliceToken, "/api/wr/health")
        return health.status === 200 ? undefined : health
      },
      { timeoutMs: TIMING.revocationCacheTtlMs + SLACK_MS, message: "new requests with an existing token were still served" },
    )
    expect(refused.elapsedMs).toBeLessThanOrEqual(TIMING.revocationCacheTtlMs + SLACK_MS)
    expect([401, 403]).toContain(refused.value.status)

    const closed = await stream.closed
    const streamBound = Math.max(TIMING.clientCheckIntervalMs + TIMING.revocationCacheTtlMs, STREAM_LEASE_TTL_MS) + SLACK_MS
    expect(closed.closedAt - revokedAt, `Bob's stream stayed open past the check bound`).toBeLessThanOrEqual(streamBound)

    const socketBound = TIMING.hostGenerationCheckIntervalMs + TIMING.hostGenerationCacheTtlMs + SLACK_MS
    const dropped = await until(
      async () => {
        const presence = await relayHostPresence(fixture, hostId, wsApi)
        return presence.active ? undefined : presence
      },
      { timeoutMs: socketBound, message: "the relay kept the revoked host's tunnel" },
    )
    expect(Date.now() - revokedAt).toBeLessThanOrEqual(socketBound + SLACK_MS)

    const exited = await connect.waitExit(fixture, state.host, BEAT_INTERVAL_MS + SLACK_MS)
    const host = await connect.status(fixture, state.host)
    expect(exited.exit?.code, host.log).toBe(78)
    expect(exited.exit!.at - revokedAt).toBeLessThanOrEqual(BEAT_INTERVAL_MS + SLACK_MS)
    expect(host.log).toContain("the control plane no longer accepts this machine")
    timing("item 7 revoke → refusals", {
      newRequestRefusedMs: refused.elapsedMs,
      newRequestBoundMs: TIMING.revocationCacheTtlMs + SLACK_MS,
      refusalStatus: refused.value.status,
      refusalCode: errorCode(refused.value.json),
      streamClosedMs: closed.closedAt - revokedAt,
      streamBoundMs: streamBound,
      hostSocketDroppedMs: dropped.elapsedMs,
      hostSocketBoundMs: socketBound,
      processExitMs: exited.exit!.at - revokedAt,
      processExitBoundMs: BEAT_INTERVAL_MS + SLACK_MS,
    })

    const audit = await relayAudit(fixture, auditSince)
    expect(audit.some((event) => event.action === "host_tunnel.disconnected" && event.hostId === hostId)).toBe(true)
    const stale = await mintHtt(fixture, { enrollmentId, hostId, workspaceId: wsApi, generation })
    const admission = await hostTunnelAdmission(fixture.info.relayUrl, hostId, wsApi, stale.hostTunnelToken)
    expect(admission.status, admission.body).toBe(403)
    expect(admission.code).toBe("host_enrollment_revoked")
  })
})

async function desktopHostRequests() {
  const response = await fetch(`${fixture.info.backendUrl}/__fixture/desktop-stats`)
  const body = (await response.json()) as { hostRequests: Array<{ method: string; path: string; phase: string; status?: number; body?: unknown }> }
  return body.hostRequests
}
