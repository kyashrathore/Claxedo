import { afterEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>> }
}

const modules = import.meta.glob("./**/*.ts")

afterEach(() => vi.unstubAllEnvs())

describe("stable actor kind", () => {
  test("browser and CLI projections cannot overwrite one actor kind", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")
    const t = convexTest(schema, modules)
    const browser = t.withIdentity({
      tokenIdentifier: "issuer|subject_1",
      subject: "subject_1",
      issuer: "issuer",
      name: "Ada",
    })
    const first = await browser.mutation(api.users.me, {})
    const cli = await t.mutation(api.users.meForService, {
      service_token: "service-secret",
      user: { token_identifier: "issuer|subject_1", subject: "subject_1", issuer: "issuer" },
    } as never)
    const again = await browser.mutation(api.users.me, {})

    expect(cli.actor_id).toBe(first.actor_id)
    expect([first.actor_kind, cli.actor_kind, again.actor_kind]).toEqual(["human", "human", "human"])
  })
})
