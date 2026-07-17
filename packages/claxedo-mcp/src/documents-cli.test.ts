import { describe, expect, it, vi } from "vitest"
import { runDocumentsCli } from "./documents-cli"

describe("documents CLI", () => {
  it("lists project documents with the configured directory default", async () => {
    const request = vi.fn(async () => [{ id: "document-1", display_name: "Plan" }])
    const stdout = vi.fn()

    await expect(runDocumentsCli(["list"], request, { stdout, stderr: vi.fn() }, { directory: "/repo" }))
      .resolves.toBe(0)

    expect(request).toHaveBeenCalledWith("/documents?directory=%2Frepo&archived=active", { method: "GET" })
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"document-1"'))
  })

  it("opens a compact reference using the current session default", async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.includes("archived=all")) return [{ id: "document-1", display_name: "Plan", archived_at: null }]
      expect(JSON.parse(String(init?.body))).toEqual({ session_id: "session-current" })
      return { document_id: "document-1", display_name: "Plan", path: "/repo/plan.md" }
    })
    const stdout = vi.fn()

    await expect(runDocumentsCli(
      ["open", "claxedo://document/document-1"],
      request,
      { stdout, stderr: vi.fn() },
      { directory: "/repo", sessionId: "session-current" },
    )).resolves.toBe(0)

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"path": "/repo/plan.md"'))
  })

  it("reports actionable usage when open has no session", async () => {
    const stderr = vi.fn()
    await expect(runDocumentsCli(
      ["open", "claxedo://document/document-1"],
      vi.fn(),
      { stdout: vi.fn(), stderr },
      { directory: "/repo" },
    )).resolves.toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--session"))
  })
})
