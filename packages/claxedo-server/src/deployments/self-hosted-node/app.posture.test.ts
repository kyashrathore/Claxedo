import { describe, expect, test } from "vitest"
import { createSelfHostedApp } from "./app"
import { SelfHostedCompositionError } from "./posture"
import type { ControlPlaneServices } from "../../authority/services"

/**
 * The gate inside the composition.
 *
 * `start.ts` asserts before binding a port, which is where a refusal is
 * cheapest. This one catches a caller that reaches `createSelfHostedApp`
 * another way — a smoke script, a future entry, a test that means to exercise
 * a real deployment shape.
 *
 * The posture is an ARGUMENT, not something read from `process.env`. That is
 * the design decision worth testing: reading the environment here would mean
 * every one of the twenty-odd existing callers either sets six variables or
 * the gate gets weakened until an empty environment passes — and a gate
 * weakened to pass its own tests is not a gate.
 */

const services = { localExecution: { enabled: true } } as unknown as ControlPlaneServices

const VALID = {
  deploymentMode: "local",
  embeddedAuth: false,
  authority: true,
  localExecution: true,
} as const

describe("createSelfHostedApp's posture gate", () => {
  test("refuses a hosted posture before composing", () => {
    expect(() => createSelfHostedApp(services, { posture: { ...VALID, deploymentMode: "hosted" } })).toThrow(
      SelfHostedCompositionError,
    )
  })

  test("refuses a missing workspace authority", () => {
    // A composition that built no authority at all.
    expect(() => createSelfHostedApp(services, { posture: { ...VALID, authority: false } })).toThrow(
      /no workspace authority is composed/,
    )
  })

  test("skips the deployment check when no posture is supplied", () => {
    // Absent means "not booting a deployment". The existing callers are tests
    // exercising route behaviour, and forcing a posture on them would be
    // asserting configuration in places that are not about configuration.
    //
    // Asserted as "not a POSTURE error" rather than "does not throw": the
    // services object here is a stub, so the composition fails later on
    // something unrelated. Claiming it throws nothing would be claiming
    // something this test cannot know.
    expect(() => createSelfHostedApp(services)).not.toThrow(SelfHostedCompositionError)
  })

  test("still enforces its own contract without a posture", () => {
    // `localExecution` is about THIS function's contract rather than a
    // deployment's configuration, so it is checked either way.
    const hosted = { localExecution: { enabled: false } } as unknown as ControlPlaneServices

    expect(() => createSelfHostedApp(hosted)).toThrow(/use createHostedApp/)
  })

  test("checks the posture before its own contract", () => {
    // A wrong posture AND a hosted services object should report the posture:
    // that is the operator-facing problem, and the other is a consequence.
    const hosted = { localExecution: { enabled: false } } as unknown as ControlPlaneServices

    expect(() => createSelfHostedApp(hosted, { posture: { ...VALID, deploymentMode: "hosted" } })).toThrow(
      SelfHostedCompositionError,
    )
  })
})
