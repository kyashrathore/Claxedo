import { beforeAll, describe, expect, test } from "bun:test"
import { canonicalJsonText, PluginReleaseError, pluginReleaseSigningBytes, verifyPluginRelease, type PluginToolDeclaration } from "./release"

const SHA = "a".repeat(64)

const release = {
  id: "counter",
  version: "0.1.0",
  manifest: {
    id: "counter",
    name: "Counter",
    version: "0.1.0",
    app: "./src/app.js",
    backend: { entry: "./src/backend.js", objects: ["Counter"], routes: ["GET /count"] },
  },
  app: { sha256: SHA, size: 10 },
  backend: { sha256: "b".repeat(64), size: 20 },
  storage: 1,
  builtAt: "2026-10-20T00:00:00.000Z",
}

let keys: Record<string, string>
let privateKey: CryptoKey

function base64(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

async function sign(value: unknown, keyId = "test") {
  return { release: value, keyId, signature: base64(await crypto.subtle.sign("Ed25519", privateKey, pluginReleaseSigningBytes(value))) }
}

async function refusal(signed: unknown) {
  try {
    await verifyPluginRelease(signed, keys)
  } catch (error) {
    if (error instanceof PluginReleaseError) return error.code
    throw error
  }
  return "verified"
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  privateKey = pair.privateKey
  keys = { test: base64(await crypto.subtle.exportKey("raw", pair.publicKey)) }
})

describe("canonical JSON", () => {
  test("sorts every object's keys and drops undefined members, whatever order they were written in", () => {
    expect(canonicalJsonText({ b: [{ z: 1, a: 2 }], a: "x", c: undefined })).toBe('{"a":"x","b":[{"a":2,"z":1}]}')
    expect(canonicalJsonText({ a: 1, b: 2 })).toBe(canonicalJsonText({ b: 2, a: 1 }))
  })
})

describe("verifyPluginRelease", () => {
  test("answers the release, with the manifest's defaults filled, once its signature verifies", async () => {
    const verified = await verifyPluginRelease(await sign(release), keys)
    expect(verified.manifest).toMatchObject({ requires: [], server: { routes: [], operations: [] }, backend: { outbound: [] } })
    expect(verified.app).toEqual({ sha256: SHA, size: 10 })
  })

  test("refuses a release changed after signing, a signature from another key, and a key it does not pin", async () => {
    const signed = await sign(release)
    expect(await refusal({ ...signed, release: { ...release, app: { sha256: "c".repeat(64), size: 10 } } })).toBe("release_signature_invalid")
    const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const forged = base64(await crypto.subtle.sign("Ed25519", other.privateKey, pluginReleaseSigningBytes(release)))
    expect(await refusal({ ...signed, signature: forged })).toBe("release_signature_invalid")
    expect(await refusal(await sign(release, "other"))).toBe("release_key_unknown")
    expect(await refusal({ ...signed, keyId: "constructor" })).toBe("release_key_unknown")
  })

  test("refuses a signed release whose parts disagree", async () => {
    expect(await refusal(await sign({ ...release, id: "other" }))).toBe("release_malformed")
    expect(await refusal(await sign({ ...release, version: "0.2.0" }))).toBe("release_malformed")
    const { backend: _backend, ...appOnly } = release
    expect(await refusal(await sign(appOnly))).toBe("release_malformed")
    expect(await refusal(await sign({ ...release, app: { sha256: SHA, size: 11 * 1024 * 1024 } }))).toBe("release_malformed")
    expect(await refusal(await sign({ ...release, extra: true }))).toBe("release_malformed")
    expect(await refusal({ release })).toBe("release_malformed")
  })

  test("carries the tools of a manifest that declares a tool group, each an MCP tool with an object input schema and its own name", async () => {
    const tool: PluginToolDeclaration = { name: "count_read", title: "Read the count", description: "Reads the count", inputSchema: { type: "object", properties: {} }, access: "read" }
    const tooled = { ...release, manifest: { ...release.manifest, backend: { ...release.manifest.backend, tools: { group: { id: "counter", label: "Counter" }, definitions: "./src/tools.js" } } } }
    expect((await verifyPluginRelease(await sign({ ...tooled, tools: [tool] }), keys)).tools).toEqual([tool])
    expect(await refusal(await sign(tooled))).toBe("release_malformed")
    expect(await refusal(await sign({ ...release, tools: [tool] }))).toBe("release_malformed")
    expect(await refusal(await sign({ ...tooled, tools: [tool, tool] }))).toBe("release_malformed")
    expect(await refusal(await sign({ ...tooled, tools: [{ ...tool, name: "Count" }] }))).toBe("release_malformed")
    expect(await refusal(await sign({ ...tooled, tools: [{ ...tool, inputSchema: { type: "string" } }] }))).toBe("release_malformed")
  })
})
