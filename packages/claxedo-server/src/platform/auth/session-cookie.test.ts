import { describe, expect, test } from "vitest"
import { BETTER_AUTH_SESSION_COOKIE, carriesSessionCookie } from "./session-cookie"

describe("the session cookie", () => {
  test("is Better Auth's secure session token under the claxedo prefix", () => {
    expect(BETTER_AUTH_SESSION_COOKIE).toBe("__Secure-claxedo.session_token")
  })

  test("a Cookie header carries a session when the token's pair has a value", () => {
    expect(carriesSessionCookie("__Secure-claxedo.session_token=opaque")).toBe(true)
    expect(carriesSessionCookie("theme=dark; __Secure-claxedo.session_token=opaque.signed; other=1")).toBe(true)
    expect(carriesSessionCookie(" __Secure-claxedo.session_token = opaque ")).toBe(true)
  })

  test("no header, other cookies, an empty token or a prefix of the name carry none", () => {
    expect(carriesSessionCookie(null)).toBe(false)
    expect(carriesSessionCookie(undefined)).toBe(false)
    expect(carriesSessionCookie("")).toBe(false)
    expect(carriesSessionCookie("theme=dark")).toBe(false)
    expect(carriesSessionCookie("__Secure-claxedo.session_token=")).toBe(false)
    expect(carriesSessionCookie("__Secure-claxedo.session_token_old=opaque")).toBe(false)
    expect(carriesSessionCookie("x__Secure-claxedo.session_token=opaque")).toBe(false)
  })
})
