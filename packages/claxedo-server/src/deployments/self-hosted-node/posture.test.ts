import { describe, expect, test } from "vitest"
import { SelfHostedCompositionError, assertSelfHostedPosture, type SelfHostedPosture } from "./posture"

/**
 * The self-hosted boot gate.
 *
 * Measured, not assumed: calling this from today's `createApp` fails 24 tests,
 * because that function also serves a `CLAXEDO_DEPLOYMENT_MODE=local` mode with
 * no embedded auth and no authority. That is the evidence for recomposing
 * rather than bolting a gate onto the mixed composition — see `posture.ts`.
 *
 * Every case here is a way to boot something that answers a health check and
 * cannot do its job — an app with no UI, a binary that cannot open a project, a
 * single-tenant deployment writing into a remote control plane. Those are worse
 * than a refusal, because a refusal names the missing variable and a silent
 * half-working deploy does not.
 */

function posture(overrides: Partial<SelfHostedPosture> = {}): SelfHostedPosture {
  return {
    deploymentMode: "self-hosted",
    embeddedAuth: true,
    authority: true,
    sqliteAuthority: true,
    localExecution: true,
    ...overrides,
  }
}

describe("assertSelfHostedPosture", () => {
  test("accepts the characterized composition", () => {
    expect(() => assertSelfHostedPosture(posture())).not.toThrow()
  })

  test("rejects a hosted deployment mode", () => {
    // The cloud binary's configuration in the self-hosted binary. Each has its
    // own gate precisely so this cannot pass.
    expect(() => assertSelfHostedPosture(posture({ deploymentMode: "hosted" }))).toThrow(SelfHostedCompositionError)
  })

  test("rejects a remote workspace authority", () => {
    // A single-tenant deployment writing into someone else's control plane.
    expect(() => assertSelfHostedPosture(posture({ sqliteAuthority: false }))).toThrow(/not the local SQLite one/)
  })

  test("distinguishes no authority from the wrong authority", () => {
    // Different fixes: one is a missing composition, the other is a wrong URL.
    expect(() => assertSelfHostedPosture(posture({ authority: false, sqliteAuthority: false }))).toThrow(
      /no workspace authority is composed/,
    )
  })

  test("rejects a build with no embedded auth", () => {
    expect(() => assertSelfHostedPosture(posture({ embeddedAuth: false }))).toThrow(/no identity provider/)
  })

  test("rejects a build that cannot open a workspace", () => {
    // The product IS local execution. Without it the binary boots, answers
    // health, and serves an app with nothing behind it.
    expect(() => assertSelfHostedPosture(posture({ localExecution: false }))).toThrow(/could not open a workspace/)
  })

  test("rejects a configured static directory that does not exist", () => {
    // A build step did not run. Serving the API with no UI reads as a broken
    // app rather than a broken deploy.
    expect(() =>
      assertSelfHostedPosture(posture({ staticAppDir: "/srv/app", staticAppDirExists: false })),
    ).toThrow(/does not exist: \/srv\/app/)
  })

  test("accepts no static directory at all, which is a valid API-only deploy", () => {
    expect(() => assertSelfHostedPosture(posture({ staticAppDir: undefined }))).not.toThrow()
  })

  test("reports every failure at once", () => {
    // Otherwise an operator fixes one environment variable per restart.
    let message = ""
    try {
      assertSelfHostedPosture({
        deploymentMode: "hosted",
        embeddedAuth: false,
        authority: false,
        sqliteAuthority: false,
        localExecution: false,
      })
    } catch (error) {
      message = String(error)
    }

    for (const fragment of ["deployment mode", "embedded auth", "workspace authority", "local-execution"]) {
      expect(message, `must report ${fragment}`).toContain(fragment)
    }
  })

  test("carries a stable code for the operator-facing error path", () => {
    try {
      assertSelfHostedPosture(posture({ embeddedAuth: false }))
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as SelfHostedCompositionError).code).toBe("self_hosted_composition_invalid")
    }
  })
})
