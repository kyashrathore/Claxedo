import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFakeControlPlane } from "@claxedo/host-connector/test-support"
import { hostKeyPairFromJwk } from "@claxedo/host-connector/host-identity"
import { sealingPublicKeyJwk } from "@claxedo/host-connector/machine-seal"

import { bundleHostConnector, HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA } from "./bundle-host-connector"
import { runHostConnectorChild } from "./host-connector-entry"
import { verifyHostConnectorChildArtifact } from "../src/main/host-connector/child-artifact"
import type { HostConnectorChildMessage, HostConnectorParentMessage } from "../src/main/host-connector/child-protocol"

const dirs: string[] = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "claxedo-host-connector-child-"))
  dirs.push(dir)
  return dir
}

/**
 * Poll against the clock, not a turn count: every wait here spans real signing
 * and real requests to the fake control plane, so how many microtask turns one
 * takes depends on how busy the machine running the suite is.
 */
async function until(condition: () => boolean, description: string, budgetMs = 5_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(0)
  }
  throw new Error(`timed out waiting for ${description}`)
}

/**
 * Like `until`, but for a condition that depends on REAL wall-clock time
 * elapsing (a `setInterval` tick) rather than one more microtask turn. 1,000
 * `Bun.sleep(0)` turns finish in a couple of milliseconds total — nowhere
 * near enough for even a single-digit-millisecond timer to fire — so this
 * polls against the clock instead of a fixed attempt count.
 */
async function untilElapsed(condition: () => boolean, description: string, budgetMs = 2_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(1)
  }
  throw new Error(`timed out waiting for ${description}`)
}

/**
 * Electron main, as the child sees it, in front of the real control plane.
 *
 * The two enrollment operations are the only ones main performs, so they are
 * answered here against the fake's state; everything the child does after them
 * is a machine-signed request the fake verifies for itself.
 */
function childHarness(options?: {
  /**
   * Withhold this operation's answer until `release()`: a control-plane POST
   * whose response is held on a warm connection for longer than the
   * supervisor's bootstrap budget.
   */
  stall?: string
  controlPlane?: ReturnType<typeof createFakeControlPlane>
  /** What main's store answers for a delivered revision; `true` unless the test says otherwise. */
  storeProviderConfig?: () => boolean
}) {
  const cp = options?.controlPlane ?? createFakeControlPlane()
  let receive: ((message: unknown) => void) | undefined
  const sent: HostConnectorChildMessage[] = []
  const accountOperations: Array<Extract<HostConnectorChildMessage, { type: "account-operation" }>> = []
  const stalled: Array<() => void> = []
  let createdIdentity: Extract<HostConnectorChildMessage, { type: "identity-created" }>["identity"] | undefined
  let storedSealingKey: JsonWebKey | undefined
  /** Every provider-config message main received, sealed and opened alike, in arrival order. */
  const providerConfigs: Array<
    | { kind: "sealed"; revision: number; sealed: string | null }
    | { kind: "opened"; revision: number; providers: string }
  > = []

  const send = (message: HostConnectorParentMessage) => receive?.(message)
  const runtime = runHostConnectorChild(
    {
      onMessage(listener) {
        receive = listener
      },
      postMessage(message) {
        sent.push(message)
        if (message.type === "identity-created") {
          createdIdentity = message.identity
          send({ type: "identity-stored", requestId: message.requestId })
          return
        }
        if (message.type === "sealing-key-created") {
          storedSealingKey = message.sealingPrivateKeyJwk
          send({ type: "sealing-key-stored", requestId: message.requestId })
          return
        }
        if (message.type === "provider-config") {
          providerConfigs.push({ kind: "sealed", revision: message.revision, sealed: message.sealed })
          const ok = options?.storeProviderConfig?.() ?? true
          send(
            ok
              ? { type: "provider-config-stored", requestId: message.requestId, ok: true }
              : { type: "provider-config-stored", requestId: message.requestId, ok: false, error: "safeStorage refused the write" },
          )
          return
        }
        if (message.type === "provider-config-ready") {
          providerConfigs.push({ kind: "opened", revision: message.revision, providers: message.providers })
          return
        }
        if (message.type !== "account-operation") return
        accountOperations.push(message)
        const answer = () =>
          void (async () => {
            const value =
              message.name === "host.enrollmentNonce"
                ? { request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 }
                : {
                  enrollment: await cp.enrollAccountHost({
                    hostId: String(message.input?.hostId),
                    publicKey: String(message.input?.publicKey),
                    ...(typeof message.input?.displayName === "string" ? { displayName: message.input.displayName } : {}),
                  }),
                }
            send({ type: "account-result", requestId: message.requestId, ok: true, value })
          })()
        if (message.name === options?.stall) {
          stalled.push(answer)
          return
        }
        answer()
      },
    },
    { fetch: cp.fetch },
  )
  return {
    cp,
    runtime,
    send,
    sent,
    accountOperations,
    createdIdentity: () => createdIdentity,
    storedSealingKey: () => storedSealingKey,
    providerConfigs,
    enrollmentId: () => [...cp.enrollments.keys()][0],
    beats: () => cp.beats(),
    release: () => stalled.splice(0).forEach((answer) => answer()),
  }
}

const CONTROL_PLANE_URL = "https://control-plane.test"

describe("the separately built child", () => {
  let built: Awaited<ReturnType<typeof bundleHostConnector>>
  beforeAll(async () => {
    built = await bundleHostConnector({ outputDir: tempDir() })
  })

  test("emits one executable with a deterministic SHA-256 manifest", async () => {
    const manifest = JSON.parse(readFileSync(built.manifestPath, "utf8")) as Record<string, unknown>
    const actualHash = createHash("sha256").update(readFileSync(built.output)).digest("hex")
    expect(manifest).toEqual({
      schema: HOST_CONNECTOR_CHILD_MANIFEST_SCHEMA,
      entry: "index.js",
      sha256: actualHash,
    })
    expect(Object.keys(manifest).sort()).toEqual(["entry", "schema", "sha256"])
  })

  test("the executable is self-contained and owns the connector implementation", () => {
    const output = readFileSync(built.output, "utf8")

    expect(output).toContain("claxedo.host-enrollment.enroll.v1")
    expect(output).not.toMatch(/from\s+["']@claxedo\/host-connector/)
  })

  test("main refuses an executable that does not match the emitted fingerprint", () => {
    const copy = tempDir()
    cpSync(built.output, join(copy, "index.js"))
    cpSync(built.manifestPath, join(copy, "manifest.json"))
    writeFileSync(join(copy, "index.js"), `${readFileSync(built.output, "utf8")}\n// tampered\n`)

    expect(() => verifyHostConnectorChildArtifact(copy)).toThrow(/fingerprint mismatch/)
  })

  test("main resolves the exact reviewed executable when its fingerprint matches", () => {
    expect(verifyHostConnectorChildArtifact(join(built.output, ".."))).toBe(built.output)
  })
})

describe("the private bootstrap protocol", () => {
  test("creates and persists the host key before named enrollment operations", async () => {
    const child = childHarness()
    const requestId = "bootstrap_1"

    child.send({ type: "bootstrap", requestId, controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000, displayName: "Work laptop" })
    await until(
      () => child.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push",
    )

    expect(child.sent[0]).toEqual({ type: "ready" })
    expect(child.createdIdentity()?.hostId).toStartWith("host_")
    expect(child.createdIdentity()?.privateKeyJwk).toHaveProperty("d")
    expect(child.accountOperations.map((message) => message.name)).toEqual([
      "host.enrollmentNonce",
      "host.enrollCurrentMachine",
    ])
    expect(JSON.stringify(child.accountOperations)).not.toMatch(/authorization|bearer|access_?token/i)
    // The reply means "alive, holding this machine's identity" — it is answered
    // before the first control-plane call goes out. The enrollment it then runs
    // announces itself on the push channel.
    expect(child.sent.find((message) => message.type === "response")).toEqual({
      type: "response",
      requestId,
      ok: true,
      status: { status: "idle" },
    })
    expect(child.sent.at(-1)).toMatchObject({ type: "status", status: { status: "enrolled" } })
    child.runtime.close()
  })

  test("answers the bootstrap while the first enrollment call is still stalled", async () => {
    const child = childHarness({ stall: "host.enrollmentNonce" })

    child.send({ type: "bootstrap", requestId: "stalled", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000 })
    await until(
      () => child.sent.some((message) => message.type === "response" && message.requestId === "stalled"),
      "bootstrap response",
    )

    // The nonce POST is still open (live, the edge holds it ~12s against a 10s
    // bootstrap budget) and the reply has already landed. It does not depend
    // on that call at all, so no stall length can push it past the budget.
    expect(child.accountOperations.map((message) => message.name)).toEqual(["host.enrollmentNonce"])
    expect(child.sent.find((message) => message.type === "response")).toMatchObject({
      ok: true,
      status: { status: "idle" },
    })
    expect(child.sent.some((message) => message.type === "status")).toBe(false)

    child.release()
    await until(
      () => child.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push after the stall clears",
    )
    expect(child.accountOperations.map((message) => message.name)).toEqual([
      "host.enrollmentNonce",
      "host.enrollCurrentMachine",
    ])
    child.runtime.close()
  })

  test("a stalled enrollment that is stopped mid-flight never claims an enrollment", async () => {
    const child = childHarness({ stall: "host.enrollmentNonce" })

    child.send({ type: "bootstrap", requestId: "stalled", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000 })
    await until(() => child.accountOperations.length === 1, "the stalled nonce request")
    child.send({ type: "stop", requestId: "stop_1" })
    await until(
      () => child.sent.some((message) => message.type === "response" && message.requestId === "stop_1"),
      "stop response",
    )
    child.release()
    await Bun.sleep(1)

    expect(child.sent.filter((message) => message.type === "status").at(-1)).toMatchObject({
      status: { status: "stopped", reason: "closed" },
    })
    expect(child.sent.some((message) => message.type === "status" && message.status.status === "enrolled")).toBe(false)
    child.runtime.close()
  })

  test("pushes a fresh status after a timer-driven heartbeat, not just after enrollment", async () => {
    // A heartbeat nobody is waiting on renews the lease; without a push for it
    // the parent's copy of `expires_at` stays where enrollment left it and
    // reads as expired while the control plane holds the lease live.
    // `heartbeatIntervalMs` is small here so a real timer tick fires inside the
    // test without a fake clock.
    const child = childHarness()
    child.send({ type: "bootstrap", requestId: "bootstrap", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20 })
    await until(
      () => child.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push",
    )
    const enrolledPush = child.sent.find(
      (message) => message.type === "status" && message.status.status === "enrolled",
    )
    const firstLease = enrolledPush?.type === "status" && enrolledPush.status.status === "enrolled"
      ? enrolledPush.status.enrollment.expires_at
      : 0
    expect(firstLease).toBeGreaterThan(0)

    const beatsAfterStart = child.beats().length
    await untilElapsed(() => child.beats().length > beatsAfterStart, "the timer-driven heartbeat")
    await untilElapsed(
      () =>
        child.sent.some(
          (message) =>
            message.type === "status"
            && message.status.status === "enrolled"
            && message.status.enrollment.expires_at > firstLease,
        ),
      "a status push carrying the heartbeat-renewed lease",
    )
    expect(child.accountOperations.map((message) => message.name)).toEqual([
      "host.enrollmentNonce",
      "host.enrollCurrentMachine",
    ])
    child.runtime.close()
  })

  test("beats with the machine key alone, and acks the workspaces it was asked to serve", async () => {
    const child = childHarness()
    child.send({
      type: "bootstrap",
      requestId: "bootstrap",
      controlPlaneUrl: CONTROL_PLANE_URL,
      heartbeatIntervalMs: 20_000,
      sessionAuthority: "local",
    })
    await until(
      () => child.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push",
    )

    const enrollmentId = child.enrollmentId()
    // The acquire and the beat are signed by the key the enrollment recorded:
    // the fake verifies every one of them and refuses anything else.
    expect(child.cp.log.map((entry) => entry.path)).toEqual([
      "/api/claxedo/host/enrollments/acquire",
      "/api/claxedo/host/enrollments/heartbeat",
    ])
    expect(child.beats()[0]?.body).toMatchObject({ generation: 1, acks: [], sessionAuthority: "local" })

    child.cp.assign({ enrollmentId, workspaceId: "ws_1", remoteDirectory: "/Users/me/project" })
    child.send({ type: "share-workspace", requestId: "share_1", workspaceId: "ws_1" })
    await until(
      () => child.sent.some((message) => message.type === "response" && message.requestId === "share_1"),
      "share response",
    )

    expect(child.sent.find((message) => message.type === "response" && message.requestId === "share_1")).toMatchObject({
      ok: true,
      status: { status: "enrolled", sharedWorkspaceIds: ["ws_1"] },
    })
    // The ack rides the beat it queued, so readiness — and the credential that
    // follows it — land one round trip after the share is answered.
    await until(() => child.cp.routable(enrollmentId).length === 1, "the workspace becoming routable")
    expect(child.sent.filter((message) => message.type === "serving").at(-1)).toMatchObject({
      tunnel: { workspaceIds: ["ws_1"] },
    })
    expect(child.accountOperations.map((message) => message.name)).toEqual([
      "host.enrollmentNonce",
      "host.enrollCurrentMachine",
    ])
    child.runtime.close()
  })

  test("the control plane's addresses ride every serving push to the parent", async () => {
    // The parent forwards a push to the daemon verbatim, and the daemon admits
    // a relayed caller against these two: the relay's key set verifies the
    // caller's Relay Host Token, the authority decides what it may read. The
    // control plane sends them only when they change, so a push without them
    // would leave the daemon answering 503 for the life of the credential.
    const child = childHarness()
    child.send({ type: "bootstrap", requestId: "bootstrap", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000 })
    await until(
      () => child.sent.some((message) => message.type === "serving"),
      "the first serving push",
    )

    expect(child.sent.find((message) => message.type === "serving")).toEqual({
      type: "serving",
      tunnel: null,
      endpoints: {
        relayJwksUrl: "https://relay.test/.well-known/jwks.json",
        sessionAuthorityUrl: `${CONTROL_PLANE_URL}/api/runtime-authority/session-authorize`,
      },
    })

    const enrollmentId = child.enrollmentId()
    child.cp.assign({ enrollmentId, workspaceId: "ws_1", remoteDirectory: "/Users/me/project" })
    child.send({ type: "share-workspace", requestId: "share_1", workspaceId: "ws_1" })
    await until(
      () => child.sent.some((message) => message.type === "serving" && message.tunnel !== null),
      "the serving push carrying the credential",
    )

    expect(child.sent.filter((message) => message.type === "serving").at(-1)).toEqual({
      type: "serving",
      tunnel: expect.objectContaining({ workspaceIds: ["ws_1"] }) as Record<string, unknown>,
      endpoints: {
        relayJwksUrl: "https://relay.test/.well-known/jwks.json",
        sessionAuthorityUrl: `${CONTROL_PLANE_URL}/api/runtime-authority/session-authorize`,
      },
    })
    child.runtime.close()
  })

  test("a workspace nobody shared here is never acked, however the owner assigned it", async () => {
    const child = childHarness()
    child.send({ type: "bootstrap", requestId: "bootstrap", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20 })
    await until(
      () => child.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push",
    )
    const enrollmentId = child.enrollmentId()
    child.cp.assign({ enrollmentId, workspaceId: "ws_elsewhere", remoteDirectory: "/Users/me/other" })

    const beatsBefore = child.beats().length
    await untilElapsed(() => child.beats().length > beatsBefore + 1, "two more beats")

    expect(child.cp.routable(enrollmentId)).toEqual([])
    for (const beat of child.beats()) expect(beat.body.acks).toEqual([])
    child.runtime.close()
  })

  test("unsharing withdraws the ack within one beat", async () => {
    const child = childHarness()
    child.send({ type: "bootstrap", requestId: "bootstrap", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000 })
    await until(
      () => child.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push",
    )
    const enrollmentId = child.enrollmentId()
    child.cp.assign({ enrollmentId, workspaceId: "ws_1", remoteDirectory: "/Users/me/project" })
    child.send({ type: "share-workspace", requestId: "share_1", workspaceId: "ws_1" })
    await until(() => child.cp.routable(enrollmentId).length === 1, "the shared workspace")

    child.send({ type: "unshare-workspace", requestId: "unshare_1", workspaceId: "ws_1" })
    await until(
      () => child.sent.some((message) => message.type === "response" && message.requestId === "unshare_1"),
      "unshare response",
    )

    expect(child.cp.routable(enrollmentId)).toEqual([])
    expect(child.beats().at(-1)?.body.acks).toEqual([])
    child.runtime.close()
  })

  test("the shares a restart carries back are re-acked from the owner's own assignments", async () => {
    const first = childHarness()
    first.send({ type: "bootstrap", requestId: "first", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000 })
    await until(() => !!first.createdIdentity(), "new identity")
    await until(
      () => first.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push",
    )
    const identity = first.createdIdentity()!
    const enrollmentId = first.enrollmentId()
    first.cp.assign({ enrollmentId, workspaceId: "ws_1", remoteDirectory: "/Users/me/project" })
    first.send({ type: "share-workspace", requestId: "share_1", workspaceId: "ws_1" })
    await until(() => first.cp.routable(enrollmentId).length === 1, "the shared workspace")
    first.runtime.close()

    const restarted = childHarness({ controlPlane: first.cp })
    restarted.send({
      type: "bootstrap",
      requestId: "restarted",
      controlPlaneUrl: CONTROL_PLANE_URL,
      heartbeatIntervalMs: 20_000,
      identity,
      sharedWorkspaces: [{ workspaceId: "ws_1" }],
    })
    await until(
      () => restarted.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push after the restart",
    )

    await until(() => restarted.cp.routable(enrollmentId).length === 1, "the restored share becoming routable")
    const restoredKeys = await hostKeyPairFromJwk(identity.privateKeyJwk)
    expect(JSON.parse(restoredKeys.publicKey)).toMatchObject(
      restarted.cp.enrollments.get(enrollmentId)!.public_key as Record<string, unknown>,
    )
    restarted.runtime.close()
  })

  test("restores an acknowledged identity without creating or exporting another", async () => {
    const first = childHarness()
    first.send({ type: "bootstrap", requestId: "first", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000 })
    await until(() => !!first.createdIdentity(), "new identity")
    const identity = first.createdIdentity()!
    first.runtime.close()

    const restored = childHarness()
    restored.send({ type: "bootstrap", requestId: "restored", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000, identity })
    await until(
      () => restored.sent.some((message) => message.type === "response" && message.requestId === "restored"),
      "restored bootstrap response",
    )

    expect(restored.sent.filter((message) => message.type === "identity-created")).toEqual([])
    expect(restored.accountOperations[0]?.input?.hostId).toBe(identity.hostId)
    restored.runtime.close()
  })

  test("stop closes the child-owned connector and acknowledges the terminal state", async () => {
    const child = childHarness()
    child.send({ type: "bootstrap", requestId: "bootstrap", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000 })
    await until(
      () => child.sent.some((message) => message.type === "response" && message.requestId === "bootstrap"),
      "bootstrap response",
    )

    child.send({ type: "stop", requestId: "stop_1" })
    await until(
      () => child.sent.some((message) => message.type === "response" && message.requestId === "stop_1"),
      "stop response",
    )

    expect(child.sent.at(-1)).toMatchObject({
      type: "response",
      requestId: "stop_1",
      ok: true,
      status: { status: "stopped", reason: "closed" },
    })
    child.runtime.close()
  })
})

const PROVIDER_CONFIG = JSON.stringify({
  version: 1,
  providers: {
    "claude-sdk": { baseUrl: "https://broker.test/bindings/b1", placeholder: "sk-placeholder-1", authMode: "api-key" },
  },
})
const EMPTY_PROVIDER_CONFIG = '{"version":1,"providers":{}}'

async function enrolled(child: ReturnType<typeof childHarness>, options: { heartbeatIntervalMs?: number } = {}) {
  child.send({
    type: "bootstrap",
    requestId: "bootstrap",
    controlPlaneUrl: CONTROL_PLANE_URL,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 20_000,
  })
  await until(
    () => child.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
    "enrolled status push",
  )
  return child.enrollmentId()
}

describe("provider configuration sealed for this machine", () => {
  test("the first beat declares a sealing key minted with the identity, and the control plane records it", async () => {
    const child = childHarness()
    const enrollmentId = await enrolled(child)

    const sealingPrivateKeyJwk = child.createdIdentity()?.sealingPrivateKeyJwk
    expect(sealingPrivateKeyJwk).toHaveProperty("d")
    const declared = JSON.stringify(sealingPublicKeyJwk(sealingPrivateKeyJwk!))
    expect(child.beats()[0]?.body).toMatchObject({ sealingPublicKey: declared })
    expect(child.cp.sealingPublicKey(enrollmentId)).toBe(declared)
    // The public half is derived, never stored on its own; the private half
    // never reaches the control plane.
    expect(JSON.stringify(child.beats().map((beat) => beat.body))).not.toContain(sealingPrivateKeyJwk!.d)
    child.runtime.close()
  })

  test("an identity from before machines could receive secrets gets its sealing key stored before the first beat", async () => {
    const first = childHarness()
    await enrolled(first)
    const { sealingPrivateKeyJwk: _minted, ...older } = first.createdIdentity()!
    first.runtime.close()

    const restored = childHarness({ controlPlane: first.cp })
    restored.send({ type: "bootstrap", requestId: "restored", controlPlaneUrl: CONTROL_PLANE_URL, heartbeatIntervalMs: 20_000, identity: older })
    await until(
      () => restored.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push after the restart",
    )

    const stored = restored.storedSealingKey()
    expect(stored).toHaveProperty("d")
    expect(restored.sent.filter((message) => message.type === "identity-created")).toEqual([])
    // Stored before the bootstrap was even answered, so no beat can declare a
    // key the parent has not persisted.
    const storedAt = restored.sent.findIndex((message) => message.type === "sealing-key-created")
    const answeredAt = restored.sent.findIndex((message) => message.type === "response")
    expect(storedAt).toBeGreaterThanOrEqual(0)
    expect(storedAt).toBeLessThan(answeredAt)
    expect(restored.cp.sealingPublicKey(restored.enrollmentId())).toBe(JSON.stringify(sealingPublicKeyJwk(stored!)))
    restored.runtime.close()
  })

  test("a pushed revision reaches the parent sealed, then opened, and is acked on the next beat", async () => {
    const child = childHarness()
    const enrollmentId = await enrolled(child, { heartbeatIntervalMs: 20 })

    const revision = await child.cp.pushProviderConfig(enrollmentId, PROVIDER_CONFIG)
    await untilElapsed(() => child.cp.providerConfigAckedRevision(enrollmentId) === revision, "the acked revision")

    const sealed = child.cp.providerConfig(enrollmentId)?.sealed
    expect(typeof sealed).toBe("string")
    expect(child.providerConfigs).toEqual([
      { kind: "sealed", revision, sealed },
      { kind: "opened", revision, providers: PROVIDER_CONFIG },
    ])
    // The parent held only the ciphertext until the child said "ready".
    expect(sealed).not.toContain("sk-placeholder-1")
    child.runtime.close()
  })

  test("a revision the parent could not store is delivered again and never acked", async () => {
    let storeOk = false
    const child = childHarness({ storeProviderConfig: () => storeOk })
    const enrollmentId = await enrolled(child, { heartbeatIntervalMs: 20 })

    const revision = await child.cp.pushProviderConfig(enrollmentId, PROVIDER_CONFIG)
    await untilElapsed(
      () => child.providerConfigs.filter((entry) => entry.kind === "sealed").length >= 2,
      "the same revision delivered twice",
    )

    expect(child.cp.providerConfigAckedRevision(enrollmentId)).not.toBe(revision)
    expect(child.providerConfigs.every((entry) => entry.kind === "sealed" && entry.revision === revision)).toBe(true)
    expect(child.providerConfigs.some((entry) => entry.kind === "opened")).toBe(false)

    storeOk = true
    await untilElapsed(() => child.cp.providerConfigAckedRevision(enrollmentId) === revision, "the acked revision")
    expect(child.providerConfigs.at(-1)).toEqual({ kind: "opened", revision, providers: PROVIDER_CONFIG })
    child.runtime.close()
  })

  test("a blob this machine cannot open is named in a message the parent logs, not only by a counter that stops", async () => {
    const child = childHarness()
    const enrollmentId = await enrolled(child, { heartbeatIntervalMs: 20 })
    const revision = await child.cp.pushProviderConfig(enrollmentId, PROVIDER_CONFIG)
    await untilElapsed(() => child.cp.providerConfigAckedRevision(enrollmentId) === revision, "the acked revision")

    // A blob sealed to a key this machine does not hold: the store succeeds
    // (it is ciphertext either way) and the open is what fails.
    child.cp.replayProviderConfig(enrollmentId, { revision: revision + 1, sealed: "mseal1.not.my.key" })
    await untilElapsed(
      () => child.sent.some((message) => message.type === "child-error"),
      "the child reporting the stage it could not complete",
    )

    const reported = child.sent.find((message) => message.type === "child-error")
    if (reported?.type !== "child-error") throw new Error("the child sent no child-error")
    expect(reported.stage).toBe("provider-config")
    expect(reported.detail).not.toBe("")
    expect(child.cp.providerConfigAckedRevision(enrollmentId)).toBe(revision)
    expect(child.providerConfigs.some((entry) => entry.kind === "opened" && entry.revision === revision + 1)).toBe(false)
    child.runtime.close()
  })

  test("a withdrawal reaches the parent as an empty configuration", async () => {
    const child = childHarness()
    const enrollmentId = await enrolled(child, { heartbeatIntervalMs: 20 })
    const configured = await child.cp.pushProviderConfig(enrollmentId, PROVIDER_CONFIG)
    await untilElapsed(() => child.cp.providerConfigAckedRevision(enrollmentId) === configured, "the configured revision")

    const withdrawn = await child.cp.pushProviderConfig(enrollmentId, null)
    await untilElapsed(() => child.cp.providerConfigAckedRevision(enrollmentId) === withdrawn, "the withdrawn revision")

    expect(child.providerConfigs.slice(-2)).toEqual([
      { kind: "sealed", revision: withdrawn, sealed: null },
      { kind: "opened", revision: withdrawn, providers: EMPTY_PROVIDER_CONFIG },
    ])
    child.runtime.close()
  })

  test("a restart re-opens the revision main stored, declares it held, and is not sent it again", async () => {
    const first = childHarness()
    const enrollmentId = await enrolled(first, { heartbeatIntervalMs: 20 })
    const revision = await first.cp.pushProviderConfig(enrollmentId, PROVIDER_CONFIG)
    await untilElapsed(() => first.cp.providerConfigAckedRevision(enrollmentId) === revision, "the acked revision")
    const identity = first.createdIdentity()!
    const stored = first.providerConfigs.find((entry) => entry.kind === "sealed")!
    first.runtime.close()
    const beatsBeforeRestart = first.beats().length

    const restarted = childHarness({ controlPlane: first.cp })
    restarted.send({
      type: "bootstrap",
      requestId: "restarted",
      controlPlaneUrl: CONTROL_PLANE_URL,
      heartbeatIntervalMs: 20,
      identity,
      providerConfig: { revision: stored.revision, sealed: stored.sealed },
    })
    await until(
      () => restarted.sent.some((message) => message.type === "status" && message.status.status === "enrolled"),
      "enrolled status push after the restart",
    )
    await untilElapsed(() => restarted.beats().length > beatsBeforeRestart + 1, "a further beat")

    // Opened for the daemon (which restarted too) before the first beat, and
    // declared on it — so across two beats nothing sealed arrived again.
    const beats = restarted.beats().slice(beatsBeforeRestart)
    expect(beats[0]?.body).toMatchObject({ providerConfigRevision: revision })
    expect(restarted.providerConfigs).toEqual([{ kind: "opened", revision, providers: PROVIDER_CONFIG }])
    restarted.runtime.close()
  })
})
