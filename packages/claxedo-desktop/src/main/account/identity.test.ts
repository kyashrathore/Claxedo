import { describe, expect, test } from "bun:test"
import { createIdentityResolver, identityFromUserInfo, userInfoUrlFromTokenUrl } from "./identity"

describe("userInfoUrlFromTokenUrl", () => {
  test("maps Clerk token endpoint to userinfo", () => {
    expect(userInfoUrlFromTokenUrl("https://suitable-elf-22.clerk.accounts.dev/oauth/token")).toBe(
      "https://suitable-elf-22.clerk.accounts.dev/oauth/userinfo",
    )
  })

  test("returns undefined for an empty URL", () => {
    expect(userInfoUrlFromTokenUrl("")).toBeUndefined()
    expect(userInfoUrlFromTokenUrl("   ")).toBeUndefined()
  })
})

describe("identityFromUserInfo", () => {
  test("prefers name, then email, and always carries sub as userId", () => {
    expect(
      identityFromUserInfo({
        sub: "user_abc",
        name: "Yash Rathore",
        email: "yash@example.com",
      }),
    ).toEqual({
      userId: "user_abc",
      displayName: "Yash Rathore",
      email: "yash@example.com",
    })
  })

  test("falls back through preferred_username and given/family name", () => {
    expect(identityFromUserInfo({ sub: "u1", preferred_username: "yash" })).toEqual({
      userId: "u1",
      displayName: "yash",
    })
    expect(identityFromUserInfo({ sub: "u2", given_name: "Yash", family_name: "R" })).toEqual({
      userId: "u2",
      displayName: "Yash R",
    })
  })

  test(" tolerates an empty or unknown body", () => {
    expect(identityFromUserInfo(null)).toEqual({ userId: "" })
    expect(identityFromUserInfo({})).toEqual({ userId: "" })
  })
})

describe("createIdentityResolver", () => {
  test("GETs userinfo with the bearer and maps the body", async () => {
    const calls: Array<{ url: string; authorization?: string | null }> = []
    const resolve = createIdentityResolver({
      userInfoUrl: "https://id.test/oauth/userinfo",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
        })
        return new Response(JSON.stringify({ sub: "user_1", name: "Ada", email: "ada@example.com" }), {
          status: 200,
        })
      },
    })

    await expect(resolve("at_live")).resolves.toEqual({
      userId: "user_1",
      displayName: "Ada",
      email: "ada@example.com",
    })
    expect(calls).toEqual([{ url: "https://id.test/oauth/userinfo", authorization: "Bearer at_live" }])
  })

  test("returns an empty identity when userinfo fails", async () => {
    const errors: unknown[] = []
    const resolve = createIdentityResolver({
      userInfoUrl: "https://id.test/oauth/userinfo",
      fetch: async () => new Response("nope", { status: 503 }),
      onError: (error) => errors.push(error),
    })

    await expect(resolve("at")).resolves.toEqual({ userId: "" })
    expect(errors).toHaveLength(1)
  })
})
