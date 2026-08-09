import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

async function until(condition: () => boolean, description: string) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (condition()) return
    await Bun.sleep(0)
  }
  throw new Error(`timed out waiting for ${description}`)
}

function childHarness() {
  let receive: ((message: unknown) => void) | undefined
  const sent: HostConnectorChildMessage[] = []
  const accountOperations: Array<Extract<HostConnectorChildMessage, { type: "account-operation" }>> = []
  let createdIdentity: Extract<HostConnectorChildMessage, { type: "identity-created" }>["identity"] | undefined

  const send = (message: HostConnectorParentMessage) => receive?.(message)
  const runtime = runHostConnectorChild({
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
      if (message.type !== "account-operation") return
      accountOperations.push(message)
      const hostId = String(message.input?.hostId)
      const value =
        message.name === "host.enrollmentNonce"
          ? { request_id: "req_1", nonce: "nonce_1", expires_at: 9_999 }
          : message.name === "host.enrollCurrentMachine"
            ? { enrollment: { enrollment_id: "enr_1", host_id: hostId, expires_at: 10_000 } }
            : { expires_at: 11_000 }
      send({ type: "account-result", requestId: message.requestId, ok: true, value })
    },
  })
  return { runtime, send, sent, accountOperations, createdIdentity: () => createdIdentity }
}

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

    child.send({ type: "bootstrap", requestId, heartbeatIntervalMs: 20_000, displayName: "Work laptop" })
    await until(
      () => child.sent.some((message) => message.type === "response" && message.requestId === requestId),
      "bootstrap response",
    )

    expect(child.sent[0]).toEqual({ type: "ready" })
    expect(child.createdIdentity()?.hostId).toStartWith("host_")
    expect(child.createdIdentity()?.privateKeyJwk).toHaveProperty("d")
    expect(child.accountOperations.map((message) => message.name)).toEqual([
      "host.enrollmentNonce",
      "host.enrollCurrentMachine",
    ])
    expect(JSON.stringify(child.accountOperations)).not.toMatch(/authorization|bearer|access_?token/i)
    expect(child.sent.at(-1)).toMatchObject({ type: "response", requestId, ok: true, status: { status: "enrolled" } })
    child.runtime.close()
  })

  test("restores an acknowledged identity without creating or exporting another", async () => {
    const first = childHarness()
    first.send({ type: "bootstrap", requestId: "first", heartbeatIntervalMs: 20_000 })
    await until(() => !!first.createdIdentity(), "new identity")
    const identity = first.createdIdentity()!
    first.runtime.close()

    const restored = childHarness()
    restored.send({ type: "bootstrap", requestId: "restored", heartbeatIntervalMs: 20_000, identity })
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
    child.send({ type: "bootstrap", requestId: "bootstrap", heartbeatIntervalMs: 20_000 })
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
