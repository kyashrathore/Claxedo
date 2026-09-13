import { describe, expect, test } from "bun:test"
import { accountIdFromClaims, accountIdFromJwt, emailFromClaims, jwtClaims } from "./claims"

function jwt(claims: Record<string, unknown>) {
  const payload = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
  return `header.${payload}.signature`
}

describe("what a login document says about its account", () => {
  test("reads a payload that is not padded and not ASCII", () => {
    const token = jwt({ email: "wörk@example.com", sub: "abc" })
    expect(jwtClaims(token)).toEqual({ email: "wörk@example.com", sub: "abc" })
    expect(emailFromClaims({ id_token: token })).toBe("wörk@example.com")
  })

  test("anything that is not a JWT names no account rather than throwing", () => {
    expect(jwtClaims(undefined)).toBeUndefined()
    expect(jwtClaims("sk-ant-api03-plain-key")).toBeUndefined()
    expect(jwtClaims("a.!!!not-base64!!!.c")).toBeUndefined()
    expect(emailFromClaims({})).toBeUndefined()
    expect(accountIdFromClaims(undefined)).toBeUndefined()
  })

  test("the id token leads, and the access token answers when it names nothing", () => {
    const id = jwt({ sub: "abc" })
    const access = jwt({ preferred_username: "person@example.com" })
    expect(emailFromClaims({ id_token: id, access_token: access })).toBe("person@example.com")
    expect(emailFromClaims({ tokens: { id_token: jwt({ email: "first@example.com" }), access_token: access } }))
      .toBe("first@example.com")
  })

  test("a bare username is not an address", () => {
    expect(emailFromClaims({ id_token: jwt({ preferred_username: "person" }) })).toBeUndefined()
    expect(emailFromClaims({ id_token: jwt({ preferred_username: "person@example.com" }) }))
      .toBe("person@example.com")
  })

  test("the OpenAI namespace keeps its own copy of both claims", () => {
    const token = jwt({ "https://api.openai.com/auth": { email: "ns@example.com", chatgpt_account_id: "acct_ns" } })
    expect(emailFromClaims({ access: token })).toBe("ns@example.com")
    expect(accountIdFromClaims({ access: token })).toBe("acct_ns")
  })

  test("an account id beats the organization list, which is the last resort", () => {
    expect(accountIdFromJwt(jwt({ chatgpt_account_id: "acct_1", organizations: [{ id: "org_1" }] }))).toBe("acct_1")
    expect(accountIdFromJwt(jwt({ organizations: [{ id: "org_1" }] }))).toBe("org_1")
    expect(accountIdFromJwt(jwt({ organizations: [] }))).toBeUndefined()
    expect(accountIdFromJwt(jwt({ organizations: "not-a-list" }))).toBeUndefined()
  })
})
