import { describe, expect, test } from "bun:test"
import { createServer } from "net"
import { findFreePort, resolvePortTemplates, isFlag } from "./index"

describe("findFreePort", () => {
  test("returns a valid port number", async () => {
    const port = await findFreePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })

  test("returned port can be bound to", async () => {
    const port = await findFreePort()
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.listen(port, () => resolve())
      server.on("error", reject)
    })
    server.close()
  })

  test("returns different ports on consecutive calls", async () => {
    const a = await findFreePort()
    const b = await findFreePort()
    // Not guaranteed but extremely likely with ephemeral ports
    expect(typeof a).toBe("number")
    expect(typeof b).toBe("number")
  })
})

describe("resolvePortTemplates", () => {
  test("replaces known templates", () => {
    const env = { URL: "http://localhost:{{port:app}}" }
    const result = resolvePortTemplates(env, { app: 3000 })
    expect(result.URL).toBe("http://localhost:3000")
  })

  test("passes through values without templates", () => {
    const env = { FOO: "bar", NUM: "123" }
    const result = resolvePortTemplates(env, { app: 3000 })
    expect(result).toEqual({ FOO: "bar", NUM: "123" })
  })

  test("replaces multiple templates in one value", () => {
    const env = { URLS: "{{port:a}},{{port:b}}" }
    const result = resolvePortTemplates(env, { a: 3000, b: 4000 })
    expect(result.URLS).toBe("3000,4000")
  })

  test("leaves unknown templates as-is", () => {
    const env = { URL: "http://localhost:{{port:unknown}}" }
    const result = resolvePortTemplates(env, { app: 3000 })
    expect(result.URL).toBe("http://localhost:{{port:unknown}}")
  })

  test("handles empty env", () => {
    const result = resolvePortTemplates({}, { app: 3000 })
    expect(result).toEqual({})
  })
})

describe("isFlag", () => {
  test("--port is a flag", () => {
    expect(isFlag("--port")).toBe(true)
  })

  test("-p is a flag", () => {
    expect(isFlag("-p")).toBe(true)
  })

  test("PORT is not a flag", () => {
    expect(isFlag("PORT")).toBe(false)
  })

  test("VITE_PORT is not a flag", () => {
    expect(isFlag("VITE_PORT")).toBe(false)
  })
})
