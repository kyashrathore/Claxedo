import { afterEach, describe, expect, test } from "vitest"
import { requireControlPlaneService } from "./model"

/**
 * F4 (pre-launch security review) — zero-downtime rotation of the control-plane
 * service token.
 *
 * The token is a shared secret held on BOTH sides: a Convex deployment env var
 * (read here) and a Worker secret. Those two swaps cannot be made atomic, so
 * while only ONE value is accepted, every rotation has an outage window in
 * which the whole serviceQuery/serviceMutation surface throws "Unauthenticated"
 * — which is what made the secret effectively unrotatable.
 *
 * `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN_PREVIOUS` is the rollover slot. These
 * tests pin the three properties that matter: the rollover actually works, the
 * widened accept set does NOT weaken the steady state, and the fail-closed
 * behaviour on missing config is preserved (an unset secret must accept
 * NOTHING, never everything).
 */

const CURRENT = "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN"
const PREVIOUS = "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN_PREVIOUS"

function setEnv(values: Partial<Record<string, string | undefined>>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterEach(() => setEnv({ [CURRENT]: undefined, [PREVIOUS]: undefined }))

const accepts = (token: string) => {
  try {
    requireControlPlaneService(token)
    return true
  } catch {
    return false
  }
}

describe("control-plane service token rotation", () => {
  test("steady state: only the configured token is accepted", () => {
    setEnv({ [CURRENT]: "token-current" })
    expect(accepts("token-current")).toBe(true)
    expect(accepts("token-previous")).toBe(false)
    expect(accepts("wrong")).toBe(false)
    expect(accepts("")).toBe(false)
  })

  test("mid-rotation: both the new and the previous token are accepted", () => {
    // Step 2 of the drill — Convex already swapped, the Worker is still rolling
    // and some instances sign with the old value. Both must work, or the skew
    // is an outage.
    setEnv({ [CURRENT]: "token-new", [PREVIOUS]: "token-old" })
    expect(accepts("token-new")).toBe(true)
    expect(accepts("token-old")).toBe(true)
    // Widening the accept set must not accept anything ELSE.
    expect(accepts("token-other")).toBe(false)
    expect(accepts("")).toBe(false)
  })

  test("after rollover: clearing PREVIOUS immediately stops accepting the old token", () => {
    setEnv({ [CURRENT]: "token-new", [PREVIOUS]: "token-old" })
    expect(accepts("token-old")).toBe(true)
    setEnv({ [PREVIOUS]: undefined })
    expect(accepts("token-old")).toBe(false)
    expect(accepts("token-new")).toBe(true)
  })

  test("fail closed: no configured token accepts nothing", () => {
    // The dangerous inversion would be "no secret configured, so allow" — an
    // unconfigured deployment must be unusable, not open.
    setEnv({ [CURRENT]: undefined, [PREVIOUS]: undefined })
    expect(accepts("")).toBe(false)
    expect(accepts("anything")).toBe(false)
  })

  test("fail closed: a PREVIOUS value alone does not authenticate", () => {
    // Guards against a half-configured deployment (someone sets only the
    // rollover slot) silently authenticating on the stale secret.
    setEnv({ [CURRENT]: undefined, [PREVIOUS]: "token-old" })
    expect(accepts("token-old")).toBe(true)
    expect(accepts("anything")).toBe(false)
  })

  test("blank and whitespace-only values are ignored, not treated as a secret", () => {
    // Otherwise `PREVIOUS=""` (a common way to "clear" a secret) would make the
    // empty string a valid credential.
    setEnv({ [CURRENT]: "token-current", [PREVIOUS]: "   " })
    expect(accepts("   ")).toBe(false)
    expect(accepts("")).toBe(false)
    expect(accepts("token-current")).toBe(true)
  })

  test("token comparison is exact — no prefix or truncation match", () => {
    setEnv({ [CURRENT]: "token-current" })
    expect(accepts("token-curren")).toBe(false)
    expect(accepts("token-current-extra")).toBe(false)
    expect(accepts("TOKEN-CURRENT")).toBe(false)
  })
})
