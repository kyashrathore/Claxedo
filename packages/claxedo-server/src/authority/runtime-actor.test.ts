import { describe, expect, test, vi } from "vitest"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"

const auth = {
  mode: "signed" as const,
  token: "signed-token",
  user: {
    subject: "upstream-subject",
    tokenIdentifier: "issuer|upstream-subject",
    issuer: "issuer",
  },
}

describe("resolveRuntimeActor", () => {
  test("uses the users registry identity instead of the upstream subject", async () => {
    const usersMe = vi.fn(async () => ({
      actor_id: "actor_registry_1",
      actor_kind: "human" as const,
      actor_public_id: "usr_public_1",
      actor_name: "Ada",
      actor_avatar_url: "https://example.test/ada.png",
      subject: "upstream-subject",
    }))

    await expect(resolveRuntimeActor({ usersMe } as never, auth)).resolves.toEqual({
      actorId: "actor_registry_1",
      actorKind: "human",
      actorPublicId: "usr_public_1",
      actorName: "Ada",
      actorAvatarUrl: "https://example.test/ada.png",
    })
    expect(usersMe).toHaveBeenCalledWith(auth)
  })

  test("fails closed when authority cannot resolve a registry actor", async () => {
    await expect(resolveRuntimeActor({ usersMe: vi.fn(async () => ({})) } as never, auth))
      .rejects.toMatchObject({ code: "workspace_authority_unavailable", status: 503 })
  })
})
