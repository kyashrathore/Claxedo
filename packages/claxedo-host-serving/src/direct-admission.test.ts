import { describe, expect, test } from "vitest"
import type { RuntimeAccessTokenClaims } from "@claxedo/workspace-relay"
import type { SessionAccessPolicy } from "@claxedo/session-core"
import { RUNTIME_ACCESS_STATE_TTL_MS, runtimeAccessAdmission } from "./direct-admission"

const claims = (jti: string) => ({ jti }) as RuntimeAccessTokenClaims

type HostDecision = Awaited<ReturnType<NonNullable<SessionAccessPolicy["authorizeHost"]>>>

function admission(decisions: HostDecision[]) {
  let now = 1_000
  const asked: Array<string | undefined> = []
  const admit = runtimeAccessAdmission({
    jwksUrl: "https://control.example/.well-known/jwks.json",
    now: () => now,
    policy: {
      authorizeHost: async (input) => {
        asked.push(input.credential)
        return decisions.shift() ?? { allowed: true }
      },
    },
  })
  return { admit, asked, advance: (ms: number) => { now += ms } }
}

describe("runtimeAccessAdmission", () => {
  test("asks the host authority with the token as the bearer, and remembers the answer for the relay's window", async () => {
    const { admit, asked, advance } = admission([{ allowed: true, lease: "l", expiresAt: 2 }, { allowed: false, status: 401, code: "runtime_access_token_revoked", message: "revoked" }])

    expect(await admit.active({ token: "t1", claims: claims("j1") })).toEqual({ active: true })
    advance(RUNTIME_ACCESS_STATE_TTL_MS - 1)
    expect(await admit.active({ token: "t1", claims: claims("j1") })).toEqual({ active: true })
    advance(1)
    expect(await admit.active({ token: "t1", claims: claims("j1") })).toEqual({ active: false, code: "runtime_access_token_revoked", message: "revoked" })
    expect(asked).toEqual(["Bearer t1", "Bearer t1"])
  })

  test("asks again at once after the authority could not answer", async () => {
    const { admit, asked } = admission([{ allowed: false, status: 503, code: "session_authority_unavailable", message: "away" }])

    expect(await admit.active({ token: "t2", claims: claims("j2") })).toMatchObject({ active: false, code: "runtime_access_token_state_unavailable" })
    expect(await admit.active({ token: "t2", claims: claims("j2") })).toEqual({ active: true })
    expect(asked).toHaveLength(2)
  })
})
