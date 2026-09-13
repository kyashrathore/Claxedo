import { describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

const root = path.join(realpathSync(os.tmpdir()), `self-hosted-authority-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const { putCredential, setActiveCredentials } = await import("@claxedo/server-core/credentials/registry")
const { selfHostedCredentialAuthority } = await import("./app")

setBackendOverride(createTestBackend())

describe("the self-hosted box's credential authority", () => {
  test("a cloud sandbox is projected from this box's marked account whether or not it runs a broker", async () => {
    // The broker serves a runtime on this listener; a cloud sandbox's
    // credential never traverses it. Installing the authority only alongside
    // the broker left an egress-broker composition answering shared scope with
    // nothing, which a harness reads as permission to use its image's login.
    const credential = await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      account_id: "acc-marked",
      scope: "shared",
      consent: { at: 1, surface: "api_key" },
      secret: "sk-ant-api03-marked",
    })
    expect(setActiveCredentials([credential.id])).toMatchObject({ ok: true })

    const withoutBroker = selfHostedCredentialAuthority()
    await expect(withoutBroker({ scope: "shared", workspaceId: "ws_1", secretBrokering: "native" }))
      .resolves.toEqual({
        "claude-sdk": {
          baseUrl: "https://api.anthropic.com",
          placeholderEnv: "CLAXEDO_PROVIDER_CLAUDE_SDK",
          authMode: "api-key",
          apiPath: "/v1",
        },
      })
  })

  test("local scope is this machine's own business and reaches no cloud delivery", async () => {
    await expect(selfHostedCredentialAuthority()({ scope: "local", workspaceId: "ws_1" })).resolves.toEqual({})
  })

  test("a broker beside it answers instead of the native delivery", async () => {
    const projectAuth = vi.fn(async () => ({
      "claude-sdk": { unavailable: true as const, reason: "secret_brokering_unsupported" },
    }))
    const withBroker = selfHostedCredentialAuthority({ projectAuth })
    await expect(withBroker({ scope: "shared", workspaceId: "ws_1" }))
      .resolves.toEqual({ "claude-sdk": { unavailable: true, reason: "secret_brokering_unsupported" } })
    expect(projectAuth).toHaveBeenCalledWith({ scope: "shared", workspaceId: "ws_1" })
  })
})
