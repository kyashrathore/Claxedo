import { describe, expect, test } from "vitest"
import { SelfHostedCompositionError, assertSelfHostedPosture, type SelfHostedPosture } from "./posture"

/**
 * The self-hosted boot gate.
 *
 * Measured, not assumed: calling this from today's `createSelfHostedApp` fails 24 tests,
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
    deploymentMode: "local",
    embeddedAuth: true,
    authority: true,
    localExecution: true,
    ...overrides,
  }
}

describe("assertSelfHostedPosture", () => {
  test("accepts the characterized composition", () => {
    expect(() => assertSelfHostedPosture(posture())).not.toThrow()
  })

  test("rejects a hosted trust posture", () => {
    // The cloud binary's configuration in the self-hosted binary. Each has its
    // own gate precisely so this cannot pass.
    //
    // `local` is the accepted value, not `self-hosted`: the mode enum is a
    // TRUST posture, not a product name — see the table in `posture.ts`.
    expect(() => assertSelfHostedPosture(posture({ deploymentMode: "hosted" }))).toThrow(SelfHostedCompositionError)
  })

  test("rejects a missing workspace authority", () => {
    // A composition that built no authority at all.
    expect(() => assertSelfHostedPosture(posture({ authority: false }))).toThrow(
      /no workspace authority is composed/,
    )
  })

  test("accepts a build with no embedded auth, which is a single-user self-host", () => {
    // `CLAXEDO_EMBEDDED_AUTH` is the MULTI-USER opt-in. A personal self-host on
    // a private box runs behind the unsigned-local gate without it, and that
    // deployment works today — requiring it here would refuse to start it.
    expect(() => assertSelfHostedPosture(posture({ embeddedAuth: false }))).not.toThrow()
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
        localExecution: false,
      })
    } catch (error) {
      message = String(error)
    }

    for (const fragment of ["deployment mode", "workspace authority", "local-execution"]) {
      expect(message, `must report ${fragment}`).toContain(fragment)
    }
  })

  test("carries a stable code for the operator-facing error path", () => {
    try {
      assertSelfHostedPosture(posture({ localExecution: false }))
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as SelfHostedCompositionError).code).toBe("self_hosted_composition_invalid")
    }
  })
})
