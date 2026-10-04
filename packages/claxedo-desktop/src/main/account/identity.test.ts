import { describe, expect, test } from "bun:test"
import { createIdentityResolver, identityFromUserInfo, userInfoUrlFromTokenUrl } from "./identity"

/** The URL of a `fetch` double's argument, whichever of the three forms it takes. */
function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input)
}

describe("userInfoUrlFromTokenUrl", () => {
  test("maps an OAuth token endpoint to userinfo", () => {
    expect(userInfoUrlFromTokenUrl("https://suitable-elf-22.issuer.example.com/oauth/token")).toBe(
      "https://suitable-elf-22.issuer.example.com/oauth/userinfo",
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

  test.each([null, {}, { sub: "   " }, { name: "Display only" }])("rejects userinfo without a canonical subject: %j", (body) => {
    expect(() => identityFromUserInfo(body)).toThrow("userinfo omitted its subject")
  })
})

describe("createIdentityResolver", () => {
  test("GETs userinfo with the bearer and maps the body", async () => {
    const calls: Array<{ url: string; authorization?: string | null }> = []
    const resolve = createIdentityResolver({
      userInfoUrl: "https://id.test/oauth/userinfo",
      fetch: async (url, init) => {
        calls.push({
          url: requestUrl(url),
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

  test("rejects when userinfo fails so the account owner can retry", async () => {
    const errors: unknown[] = []
    const resolve = createIdentityResolver({
      userInfoUrl: "https://id.test/oauth/userinfo",
      fetch: async () => new Response("nope", { status: 503 }),
      onError: (error) => errors.push(error),
    })

    await expect(resolve("at")).rejects.toThrow("userinfo failed: 503")
    expect(errors).toHaveLength(1)
  })

  test("bounds a userinfo request that never settles", async () => {
    const errors: unknown[] = []
    const resolve = createIdentityResolver({
      userInfoUrl: "https://id.test/oauth/userinfo",
      fetch: async () => await new Promise<Response>(() => {}),
      onError: (error) => errors.push(error),
      timeoutMs: 1,
    })

    await expect(resolve("at")).rejects.toThrow("userinfo timed out")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
    expect((errors[0] as Error).message).toBe("userinfo timed out")
  })
  test("bounds a body decode that stalls after headers arrive", async () => {
    let signal: AbortSignal | undefined
    const resolve = createIdentityResolver({
      userInfoUrl: "https://id.test/oauth/userinfo",
      fetch: async (_url, init) => {
        signal = init?.signal ?? undefined
        return { ok: true, json: () => new Promise(() => {}) } as Response
      },
      timeoutMs: 1,
    })
    await expect(resolve("at")).rejects.toThrow("userinfo timed out")
    expect(signal?.aborted).toBe(true)
  })

})
