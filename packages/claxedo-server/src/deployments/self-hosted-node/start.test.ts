import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SelfHostedCompositionError, assertSelfHostedPosture } from "./posture"
import { selfHostedPosture, staticAppPosture } from "./start"

/**
 * The self-hosted entry's posture reading, and the wiring that makes it run.
 *
 * `startSelfHostedServer` itself boots a real server, so what is testable is
 * split out: `selfHostedPosture` observes, `assertSelfHostedPosture` judges,
 * and a source check confirms the entry calls them in that order before
 * composing anything. Booting to find out would mean the operator learns from
 * a user rather than a log line.
 */

const start = readFileSync(path.join(import.meta.dirname, "start.ts"), "utf8")
const entry = readFileSync(path.join(import.meta.dirname, "index.ts"), "utf8")

describe("selfHostedPosture", () => {
  test("reads the deployment mode from the environment", () => {
    // `local` is the self-hosted binary's TRUST posture; the mode enum is not
    // a product name. See the table in `posture.ts`.
    expect(selfHostedPosture({ CLAXEDO_DEPLOYMENT_MODE: "local" })).toMatchObject({ deploymentMode: "local" })
  })

  test("what it reports passes the gate for a correctly configured self-host", () => {
    // The two halves have to agree. A posture reader that produced a shape the
    // assertion rejects would make every self-host refuse to start.
    const posture = selfHostedPosture({
      CLAXEDO_DEPLOYMENT_MODE: "local",
      CLAXEDO_EMBEDDED_AUTH: "1",
    })

    expect(() => assertSelfHostedPosture(posture)).not.toThrow()
  })

  test("a hosted-mode environment is refused", () => {
    const posture = selfHostedPosture({ CLAXEDO_DEPLOYMENT_MODE: "hosted", CLAXEDO_EMBEDDED_AUTH: "1" })

    expect(() => assertSelfHostedPosture(posture)).toThrow(SelfHostedCompositionError)
  })

  test("an environment with no embedded auth still starts", () => {
    // The single-user self-host.  is the multi-user
    // opt-in, and refusing without it would break a deployment that works.
    expect(() => assertSelfHostedPosture(selfHostedPosture({ CLAXEDO_DEPLOYMENT_MODE: "local" }))).not.toThrow()
  })
})

describe("staticAppPosture", () => {
  test("reports nothing when no bundle is configured", () => {
    // An API-only self-host is supported; absence must not read as an error.
    expect(staticAppPosture(undefined)).toEqual({})
  })

  test("reports a configured directory that does not exist", () => {
    // A build step did not run. Serving the API with no UI reads as a broken
    // app rather than a broken deploy.
    expect(staticAppPosture("/definitely/not/here")).toEqual({
      staticAppDir: "/definitely/not/here",
      staticAppDirExists: false,
    })
  })
})

describe("the self-hosted entry wiring", () => {
  test("asserts the posture before composing anything", () => {
    // Order is the property. A gate that ran after `startServer` would let the
    // listener come up on a configuration it was about to reject.
    expect(start.indexOf("assertSelfHostedPosture(")).toBeLessThan(start.indexOf("return startServer("))
  })

  test("the process entry goes through the gated start, not startServer", () => {
    // `startServer` had exactly one production caller left after Unit 5 — this
    // entry. Calling it directly would skip the gate entirely.
    expect(entry).toContain("startSelfHostedServer({")
    expect(entry).not.toContain("startServer(")
  })

  test("passes the self-hosted capability factory", () => {
    // The single argument that keeps WorkGraph and Documents composed after the
    // desktop-local composition stopped contributing any. Dropping it would
    // silently remove two features from the self-hosted product.
    expect(start).toContain("capabilities: selfHostedCapabilities")
  })
})
