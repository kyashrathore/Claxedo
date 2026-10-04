import { describe, expect, test } from "bun:test"
import { isTrustedRendererDocumentUrl } from "./renderer-url-trust"

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
