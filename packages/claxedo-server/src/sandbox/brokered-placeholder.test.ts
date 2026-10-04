import { describe, expect, test } from "vitest"
import { brokeredSecretPlaceholder } from "@claxedo/sandbox-manager"
import { credentialPlaceholder } from "../../scripts/sandbox/cloudflare-worker/src/outbound-credentials"

/**
 * The two sides of the Cloudflare credential handshake live in different
 * packages — the Worker is deployed on its own and cannot depend on the sandbox
 * manager — so nothing but this file makes them agree. A driver that mints a
 * placeholder the Worker does not recognize sends every brokered request
 * upstream with no credential on it.
 */
describe("brokered placeholder, driver against worker", () => {
  test.each(["CLAXEDO_PROVIDER_CLAUDE_SDK", "CLAXEDO_GITHUB_CLONE_AUTH", "A"])(
    "the driver mints exactly what the worker matches for %s",
    (name) => {
      // Anchored to the literal as well as to each other: two sides that agreed
      // on "" would pass a pure equality check while every request went
      // upstream bare.
      expect(brokeredSecretPlaceholder(name)).toBe(`claxedo-broker:${name}`)
      expect(credentialPlaceholder(name)).toBe(`claxedo-broker:${name}`)
    },
  )
})
