import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { localPiCredentialProviders, localPiModelBackendResolver } from "./local-auth"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("localPiModelBackendResolver", () => {
  test("uses an explicit model exactly and reports credential availability without secrets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-local-auth-"))
    dirs.push(dir)
    const piAuthPath = path.join(dir, "auth.json")
    await Bun.write(piAuthPath, JSON.stringify({ openai: { type: "api_key", key: "test-secret" } }))
    const options = { piAuthPath, codexAuthPath: path.join(dir, "missing-codex.json") }
    const resolver = localPiModelBackendResolver(options)

    const backend = await resolver({
      sessionId: "session-a",
      model: { providerID: "openai", modelID: "gpt-4.1" },
    })

    expect(backend?.model).toMatchObject({ provider: "openai", id: "gpt-4.1" })
    expect(await backend?.getApiKey("openai")).toBe("test-secret")
    expect(localPiCredentialProviders(options)).toContain("openai")
  })
})
