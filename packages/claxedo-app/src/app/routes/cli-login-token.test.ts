import { afterEach, describe, expect, test } from "bun:test"
import { cliCallbackFields, cliToken, localCallback, number, postToken, text, userIdentity } from "./cli-login-token"

describe("localCallback (loopback restriction)", () => {
  test("accepts http loopback hosts", () => {
    expect(localCallback("http://127.0.0.1:9000/cb")).toBe("http://127.0.0.1:9000/cb")
    expect(localCallback("http://localhost:1234/x")).toBe("http://localhost:1234/x")
    expect(localCallback("http://[::1]:5000/")).toBeDefined()
  })

  test("rejects non-loopback hosts", () => {
    expect(localCallback("http://evil.example.com/cb")).toBeUndefined()
    expect(localCallback("http://169.254.169.254/")).toBeUndefined()
  })

  test("rejects non-http protocols even on loopback", () => {
    expect(localCallback("https://localhost/cb")).toBeUndefined()
    expect(localCallback("file://localhost/cb")).toBeUndefined()
  })

  test("rejects empty/invalid input", () => {
    expect(localCallback(null)).toBeUndefined()
    expect(localCallback("")).toBeUndefined()
    expect(localCallback("not a url")).toBeUndefined()
  })
})

describe("userIdentity", () => {
  test("prefers email, then full name, then id, then fallback", () => {
    expect(userIdentity({ primaryEmailAddress: { emailAddress: "a@b.com" }, fullName: "A", id: "1" })).toBe("a@b.com")
    expect(userIdentity({ fullName: "Full Name", id: "1" })).toBe("Full Name")
    expect(userIdentity({ id: "user_1" })).toBe("user_1")
    expect(userIdentity({})).toBe("browser-session")
    expect(userIdentity(null)).toBe("browser-session")
  })
})

describe("text / number coercion", () => {
  test("text trims and rejects blanks/non-strings", () => {
    expect(text("  hi ")).toBe("hi")
    expect(text("   ")).toBeUndefined()
    expect(text(42)).toBeUndefined()
  })

  test("number accepts finite numbers only", () => {
    expect(number(10)).toBe(10)
    expect(number(Number.NaN)).toBeUndefined()
    expect(number(Infinity)).toBeUndefined()
    expect(number("10")).toBeUndefined()
  })
})

describe("cliCallbackFields", () => {
  test("includes only present optional fields and stringifies expiresIn", () => {
    expect(
      cliCallbackFields({
        state: "s",
        accessToken: "at",
        identity: "me",
        refreshToken: "rt",
        tokenType: "bearer",
        expiresIn: 3600,
      }),
    ).toEqual({
      state: "s",
      access_token: "at",
      identity: "me",
      refresh_token: "rt",
      token_type: "bearer",
      expires_in: "3600",
    })
  })

  test("omits absent optional fields", () => {
    expect(cliCallbackFields({ state: "s", accessToken: "at", identity: "me" })).toEqual({
      state: "s",
      access_token: "at",
      identity: "me",
    })
  })
})

describe("cliToken exchange", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const stubFetch = (response: { ok: boolean; body: unknown }) => {
    globalThis.fetch = async () => new Response(JSON.stringify(response.body), { status: response.ok ? 200 : 400 })
  }

  test("returns tokens from a snake_case response", async () => {
    stubFetch({
      ok: true,
      body: { access_token: "at", refresh_token: "rt", token_type: "bearer", expires_in: 60 },
    })
    expect(await cliToken("browser")).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      tokenType: "bearer",
      expiresIn: 60,
    })
  })

  test("accepts camelCase spellings too", async () => {
    stubFetch({ ok: true, body: { accessToken: "at2", refreshToken: "rt2", expiresIn: 90 } })
    const result = await cliToken("browser")
    expect(result.accessToken).toBe("at2")
    expect(result.refreshToken).toBe("rt2")
    expect(result.expiresIn).toBe(90)
  })

  test("surfaces the server error message on a non-ok response", async () => {
    stubFetch({ ok: false, body: { error: { message: "nope, not allowed" } } })
    await expect(cliToken("browser")).rejects.toThrow("nope, not allowed")
  })

  test("uses a default message when the error body has none", async () => {
    stubFetch({ ok: false, body: {} })
    await expect(cliToken("browser")).rejects.toThrow("CLI token exchange failed.")
  })

  test("throws when the ok response lacks an access token", async () => {
    stubFetch({ ok: true, body: { refresh_token: "rt" } })
    await expect(cliToken("browser")).rejects.toThrow("did not return an access token")
  })

  test("throws when the ok response is not an object", async () => {
    stubFetch({ ok: true, body: "surprise" })
    await expect(cliToken("browser")).rejects.toThrow("invalid response")
  })
})

describe("postToken (DOM form)", () => {
  test("builds a hidden POST form targeting the callback with all fields", () => {
    let submittedAction: string | undefined
    const submit = HTMLFormElement.prototype.submit
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      submittedAction = this.action
    }
    try {
      postToken({
        callback: "http://127.0.0.1:9000/cb",
        state: "state-1",
        accessToken: "at",
        identity: "me",
        refreshToken: "rt",
      })
      const form = document.querySelector("form")
      expect(form).not.toBeNull()
      expect(form!.method.toUpperCase()).toBe("POST")
      const fields = Object.fromEntries([...form!.querySelectorAll("input")].map((el) => [el.name, el.value]))
      expect(fields).toMatchObject({
        state: "state-1",
        access_token: "at",
        identity: "me",
        refresh_token: "rt",
      })
      expect(submittedAction).toContain("127.0.0.1:9000/cb")
      form!.remove()
    } finally {
      HTMLFormElement.prototype.submit = submit
    }
  })
})
