import { beforeAll, describe, expect, test } from "bun:test"
import { verifyPluginIndex } from "./registry-index"
import { PluginReleaseError, pluginReleaseSigningBytes } from "./release"

const manifest = { id: "counter", name: "Counter", version: "0.2.0", app: "./src/app.js" }
const entry = { id: "counter", name: "Counter", description: "Counts", latest: "0.2.0", versions: ["0.2.0", "0.1.0"], manifest }
const index = { entries: [entry], builtAt: "2026-10-20T00:00:00.000Z" }

let keys: Record<string, string>
let privateKey: CryptoKey

function base64(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

async function sign(value: unknown, keyId = "test") {
  return { index: value, keyId, signature: base64(await crypto.subtle.sign("Ed25519", privateKey, pluginReleaseSigningBytes(value))) }
}

async function refusal(signed: unknown) {
  try {
    await verifyPluginIndex(signed, keys)
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

describe("verifyPluginIndex", () => {
  test("answers the index with each latest manifest's defaults filled, once its signature verifies", async () => {
    const verified = await verifyPluginIndex(await sign(index), keys)
    expect(verified.entries.map((listed) => [listed.id, listed.latest, listed.versions])).toEqual([["counter", "0.2.0", ["0.2.0", "0.1.0"]]])
    expect(verified.entries[0]?.manifest).toMatchObject({ requires: [], server: { routes: [], operations: [] } })
  })

  test("refuses an index changed after signing or signed by a key it does not pin", async () => {
    const signed = await sign(index)
    expect(await refusal({ ...signed, index: { ...index, entries: [{ ...entry, description: "Changed" }] } })).toBe("release_signature_invalid")
    expect(await refusal(await sign(index, "other"))).toBe("release_key_unknown")
  })

  test("refuses an entry whose manifest is not its latest version, a latest it does not publish, and a plugin listed twice", async () => {
    expect(await refusal(await sign({ ...index, entries: [{ ...entry, latest: "0.1.0" }] }))).toBe("release_malformed")
    expect(await refusal(await sign({ ...index, entries: [{ ...entry, versions: ["0.1.0"] }] }))).toBe("release_malformed")
    expect(await refusal(await sign({ ...index, entries: [entry, entry] }))).toBe("release_malformed")
    expect(await refusal({ index })).toBe("release_malformed")
  })
})
