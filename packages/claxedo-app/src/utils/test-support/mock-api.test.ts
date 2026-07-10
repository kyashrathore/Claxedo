import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createMockApi, mockApiRegistration } from "./mock-api"

describe("createMockApi defaults", () => {
  test("api.get resolves the JSON body of the configured response", async () => {
    const fixture = createMockApi({ baseUrl: "http://test.local" })

    const result = await fixture.module.api.get<{ ok: boolean }>("/pages")

    expect(result).toEqual({})
    expect(fixture.calls).toEqual([{ url: "http://test.local/pages", init: undefined }])
  })

  test("api.post records the JSON-stringified body and POST method", async () => {
    const fixture = createMockApi({ baseUrl: "http://test.local" })

    await fixture.module.api.post("/pages", { title: "My Page" })

    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0]?.url).toBe("http://test.local/pages")
    expect(fixture.calls[0]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ title: "My Page" }),
    })
  })

  test("api.delete sends the DELETE method with no body", async () => {
    const fixture = createMockApi({ baseUrl: "http://test.local" })

    await fixture.module.api.delete("/pages/my-id")

    expect(fixture.calls[0]).toEqual({
      url: "http://test.local/pages/my-id",
      init: { method: "DELETE", body: undefined },
    })
  })

  test("relative URLs resolve against getClaxedoServerUrl, absolute URLs pass through unchanged", async () => {
    const fixture = createMockApi({ baseUrl: "http://test.local" })

    await fixture.module.api.get("/relative")
    await fixture.module.authFetch("https://external.example/absolute")

    expect(fixture.calls.map((call) => call.url)).toEqual([
      "http://test.local/relative",
      "https://external.example/absolute",
    ])
  })

  test("fail() makes every subsequent api.* call reject with the response body as the error message", async () => {
    const fixture = createMockApi({ baseUrl: "http://test.local" })
    fixture.fail(409, JSON.stringify({ error: "page_version_conflict" }))

    await expect(fixture.module.api.get("/pages")).rejects.toThrow(JSON.stringify({ error: "page_version_conflict" }))
  })

  test("fail() with no body falls back to a generic 'Request failed: <status>' message", async () => {
    const fixture = createMockApi({ baseUrl: "http://test.local" })
    fixture.fail(500, "")

    await expect(fixture.module.api.get("/pages")).rejects.toThrow("Request failed: 500")
  })

  test("setResponse(Response) is served as-is, including a non-JSON content type", async () => {
    const fixture = createMockApi({ baseUrl: "http://test.local" })
    fixture.setResponse(new Response("# Page", { status: 200, headers: { "Content-Type": "text/markdown" } }))

    const res = await fixture.module.authFetch("http://test.local/pages/1/export")

    expect(res.headers.get("Content-Type")).toBe("text/markdown")
    expect(await res.text()).toBe("# Page")
  })

  test("reset() clears recorded calls and restores the default 200 {} response", async () => {
    const fixture = createMockApi({ baseUrl: "http://test.local" })
    fixture.fail(500)
    await fixture.module.api.get("/pages").catch(() => undefined)
    expect(fixture.calls).toHaveLength(1)

    fixture.reset()

    expect(fixture.calls).toEqual([])
    const result = await fixture.module.api.get("/pages")
    expect(result).toEqual({})
  })

  test("baseUrl sets getClaxedoServerUrl, getConfiguredClaxedoServerUrl, and getDefaultBaseUrl together", () => {
    const fixture = createMockApi({ baseUrl: "http://test.local" })

    expect(fixture.module.getClaxedoServerUrl()).toBe("http://test.local")
    expect(fixture.module.getConfiguredClaxedoServerUrl()).toBe("http://test.local")
    expect(fixture.module.getDefaultBaseUrl()).toBe("http://test.local")
  })

  test("without baseUrl, getClaxedoServerUrl/getDefaultBaseUrl default to http://test.local and getConfiguredClaxedoServerUrl defaults to undefined", () => {
    const fixture = createMockApi()

    expect(fixture.module.getClaxedoServerUrl()).toBe("http://test.local")
    expect(fixture.module.getDefaultBaseUrl()).toBe("http://test.local")
    expect(fixture.module.getConfiguredClaxedoServerUrl()).toBeUndefined()
  })

  test("per-export overrides replace only the named export, leaving the rest at their defaults", async () => {
    const fixture = createMockApi({
      baseUrl: "http://test.local",
      isDemoMode: () => true,
    })

    expect(fixture.module.isDemoMode()).toBe(true)
    expect(fixture.module.isDemoPath("/demo/x")).toBe(true)
    expect(fixture.module.isDemoPath("/x")).toBe(false)
  })

  test("overriding authFetch bypasses the built-in call recorder entirely", async () => {
    const customCalls: string[] = []
    const fixture = createMockApi({
      baseUrl: "http://test.local",
      authFetch: async (input) => {
        customCalls.push(String(input))
        return Response.json({ routed: true })
      },
    })

    const result = await fixture.module.api.get("/routed")

    expect(customCalls).toEqual(["http://test.local/routed"])
    expect(result).toEqual({ routed: true })
    expect(fixture.calls).toEqual([])
  })
})

describe("pure export mirrors match the real ../api.ts implementation", () => {
  // Bypass any mock.module("./api"/"@claxedo/utils/api") registered by
  // other files in this test run — same cache-busting-query technique
  // api.test.ts uses — so this always evaluates the genuine module.
  test("isDemoPath, fixDir, normalizeUrl, isHostedAppHostname, isEmbedMode agree with the real module across a fixed input table", async () => {
    const real = await import(`${import.meta.dir}/../api.ts?mock-api-contract`)
    const fixture = createMockApi()

    const demoPathInputs = ["/", "/demo", "/demo/", "/demo/foo", "/foo/demo"]
    for (const input of demoPathInputs) {
      expect(fixture.module.isDemoPath(input)).toBe(real.isDemoPath(input))
    }

    const fixDirInputs = ["/absolute/path", undefined, "relative", "prefix/Users/me/project", "Users/me/project"]
    for (const input of fixDirInputs) {
      expect(fixture.module.fixDir(input)).toBe(real.fixDir(input))
    }

    const normalizeUrlInputs = [undefined, "", "  ", "http://x.test/", "http://x.test///", "http://x.test"]
    for (const input of normalizeUrlInputs) {
      expect(fixture.module.normalizeUrl(input)).toBe(real.normalizeUrl(input))
    }

    const hostnameInputs = ["opencode.ai", "app.opencode.ai", "notopencode.ai", "opencode.ai.evil.test", undefined]
    for (const input of hostnameInputs) {
      expect(fixture.module.isHostedAppHostname(input)).toBe(real.isHostedAppHostname(input))
    }

    // isEmbedMode/isDemoMode read window.location — compare under the same URL.
    window.location.href = "http://localhost/demo/?embed=1"
    expect(fixture.module.isEmbedMode()).toBe(real.isEmbedMode())
    expect(fixture.module.isDemoMode()).toBe(real.isDemoMode())

    window.location.href = "http://localhost/"
    expect(fixture.module.isEmbedMode()).toBe(real.isEmbedMode())
    expect(fixture.module.isDemoMode()).toBe(real.isDemoMode())
  })
})

describe("mock.module(...register) registers the fixture against the shared alias", () => {
  let calls: Array<{ url: string; init?: RequestInit }>

  beforeEach(() => {
    // mockApiRegistration's default specifier ("@claxedo/utils/api") resolves,
    // via tsconfig paths, to the same absolute module every consumer's
    // "./api" / "../../utils/api" specifiers do — this test proves that
    // redirection works, standing in for a real consumer file wiring the
    // fixture up the way the module header's usage example shows.
    const { fixture, register } = mockApiRegistration({ baseUrl: "http://installed.test" })
    mock.module(...register)
    calls = fixture.calls
  })

  test("a module imported after registration sees the mocked @claxedo/utils/api", async () => {
    const { api } = await import("@claxedo/utils/api")

    const result = await api.get("/probe")

    expect(result).toEqual({})
    expect(calls).toEqual([{ url: "http://installed.test/probe", init: undefined }])
  })
})
