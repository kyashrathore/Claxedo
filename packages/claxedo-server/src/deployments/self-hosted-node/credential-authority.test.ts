import { describe, expect, test, vi } from "vitest"

const { selfHostedCredentialAuthority } = await import("./app")

describe("the self-hosted box's credential authority", () => {
  test("a cloud sandbox is projected for whether or not this box runs a loopback broker", async () => {
    // The broker serves a runtime on this listener; a cloud sandbox's
    // credential never traverses it. Installing the authority only alongside
    // the broker left an egress-broker composition answering shared scope with
    // nothing, which a harness reads as permission to use its image's login.
    const withoutBroker = selfHostedCredentialAuthority()
    expect(withoutBroker).toBeDefined()
    await expect(withoutBroker!({ scope: "shared", workspaceId: "ws_1" })).resolves.toEqual({})

    const projectAuth = vi.fn(async () => ({
      "claude-sdk": { unavailable: true as const, reason: "secret_brokering_unsupported" },
    }))
    const withBroker = selfHostedCredentialAuthority({ projectAuth })
    await expect(withBroker!({ scope: "shared", workspaceId: "ws_1" }))
      .resolves.toEqual({ "claude-sdk": { unavailable: true, reason: "secret_brokering_unsupported" } })
    expect(projectAuth).toHaveBeenCalledWith({ scope: "shared", workspaceId: "ws_1" })
  })
})
