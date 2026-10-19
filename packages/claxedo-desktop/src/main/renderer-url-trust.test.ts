import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { isTrustedRendererDocumentUrl, rendererDevServerUrl } from "./renderer-url-trust"

const packagedIndexUrl = "file:///Applications/Claxedo.app/Contents/Resources/app/renderer/index.html"

describe("renderer document URL trust", () => {
  test("accepts the configured Vite origin and pathname-based application routes", () => {
    const options = { devServerUrl: "http://localhost:5173/", packagedIndexUrl }
    expect(isTrustedRendererDocumentUrl("http://localhost:5173/", options)).toBe(true)
    expect(isTrustedRendererDocumentUrl("http://localhost:5173/index.html", options)).toBe(true)
    expect(isTrustedRendererDocumentUrl("http://localhost:5173/?workspace=local#session", options)).toBe(true)
    expect(isTrustedRendererDocumentUrl("http://localhost:5173/Users/me/project/session/ses_1", options)).toBe(true)
  })

  test("rejects other origins in development", () => {
    const options = { devServerUrl: "http://localhost:5173/", packagedIndexUrl }
    expect(isTrustedRendererDocumentUrl("http://127.0.0.1:5173/", options)).toBe(false)
    expect(isTrustedRendererDocumentUrl("http://localhost:5174/", options)).toBe(false)
    expect(isTrustedRendererDocumentUrl("https://localhost:5173/", options)).toBe(false)
    expect(isTrustedRendererDocumentUrl("https://example.com/", options)).toBe(false)
  })

  test("accepts only the packaged index document outside development", () => {
    const options = { packagedIndexUrl }
    expect(isTrustedRendererDocumentUrl(`${packagedIndexUrl}#session`, options)).toBe(true)
    expect(isTrustedRendererDocumentUrl("file:///Applications/Claxedo.app/Contents/Resources/app/renderer/loading.html", options)).toBe(false)
  })
})

test("a document whose path carries a tilde matches however the tilde is spelled, and a reserved escape keeps its meaning", () => {
  const options = { packagedIndexUrl: "file:///C:/Users/RUNNER%7E1/AppData/Local/Programs/Claxedo/resources/app.asar/out/renderer/index.html" }

  expect(isTrustedRendererDocumentUrl("file:///C:/Users/RUNNER~1/AppData/Local/Programs/Claxedo/resources/app.asar/out/renderer/index.html?w=1", options)).toBe(true)
  expect(isTrustedRendererDocumentUrl("file:///C:/Users/RUNNER~2/AppData/Local/Programs/Claxedo/resources/app.asar/out/renderer/index.html", options)).toBe(false)
  expect(isTrustedRendererDocumentUrl("file:///C:/Users/RUNNER%7E1/AppData/Local/Programs/Claxedo/resources/app.asar%2Fout/renderer/index.html", options)).toBe(false)
})

describe("renderer dev server", () => {
  test("a packaged build ignores a dev server its launch environment names", () => {
    const env = { ELECTRON_RENDERER_URL: "http://localhost:5173/" }
    expect(rendererDevServerUrl(env, true)).toBeUndefined()
    expect(rendererDevServerUrl(env, false)).toBe("http://localhost:5173/")
  })

  test("only the dev server policy reads the launch environment's renderer URL", () => {
    const readers = readdirSync(import.meta.dir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => readFileSync(path.join(import.meta.dir, file), "utf8").includes("ELECTRON_RENDERER_URL"))
    expect(readers).toEqual(["renderer-url-trust.ts"])
  })
})
