import { describe, expect, it, vi } from "vitest"
import { callDocuments, registerDocumentTools } from "./documents-tools"

describe("document discovery tools", () => {
  it("lists metadata without passing through content bodies", async () => {
    const request = vi.fn(async () => [
      {
        id: "document-1",
        project_id: "project-1",
        display_name: "Plan",
        origin_kind: "managed",
        placement_kind: "local",
        status: "draft",
        archived_at: null,
        markdown: "secret body",
        content: "also secret",
      },
    ])

    const result = await callDocuments(request, "documents_list", { project_id: "project-1" })
    const body = JSON.parse(result.content[0]!.text) as { documents: Record<string, unknown>[] }
    expect(body.documents).toEqual([
      {
        id: "document-1",
        project_id: "project-1",
        display_name: "Plan",
        origin_kind: "managed",
        placement_kind: "local",
        status: "draft",
        archived_at: null,
      },
    ])
    expect(JSON.stringify(body)).not.toContain("secret")
    expect(request).toHaveBeenCalledWith("/documents?project_id=project-1&archived=active", { method: "GET" })
  })

  it("resolves by id or display name and returns the server's canonical path", async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.includes("archived=all"))
        return [
          {
            id: "document-1",
            project_id: "project-1",
            display_name: "Plan",
            origin_kind: "managed",
            placement_kind: "local",
            status: "draft",
            archived_at: null,
          },
        ]
      expect(path).toBe("/documents/document-1/agent-open")
      expect(JSON.parse(String(init?.body))).toEqual({ session_id: "session-1" })
      return { document_id: "document-1", display_name: "Plan", path: "/data/documents/project-1/document-1/plan.md" }
    })

    const result = await callDocuments(request, "documents_open", {
      id_or_name: "plan",
      project_id: "project-1",
      session_id: "session-1",
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      document_id: "document-1",
      display_name: "Plan",
      path: "/data/documents/project-1/document-1/plan.md",
    })
  })

  it("resolves a compact Claxedo document reference", async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.includes("archived=all")) return [{ id: "document-1", display_name: "Plan", archived_at: null }]
      expect(path).toBe("/documents/document-1/agent-open")
      expect(JSON.parse(String(init?.body))).toEqual({ session_id: "session-1" })
      return { document_id: "document-1", display_name: "Plan", path: "/data/documents/document-1/plan.md" }
    })

    const result = await callDocuments(request, "documents_open", {
      id_or_name: "claxedo://document/document-1",
      directory: "/repo",
      session_id: "session-1",
    })

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ document_id: "document-1" })
  })

  it("prefers an exact stable id over another document whose display name collides with it", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes("archived=all"))
        return [
          {
            id: "document-1",
            project_id: "project-1",
            display_name: "Plan",
            archived_at: null,
          },
          {
            id: "document-2",
            project_id: "project-1",
            display_name: "document-1",
            archived_at: null,
          },
        ]
      expect(path).toBe("/documents/document-1/agent-open")
      return { document_id: "document-1", display_name: "Plan", path: "/data/documents/document-1/plan.md" }
    })

    const result = await callDocuments(request, "documents_open", {
      id_or_name: "document-1",
      project_id: "project-1",
      session_id: "session-1",
    })

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      document_id: "document-1",
      path: "/data/documents/document-1/plan.md",
    })
  })

  it("returns typed honest errors for archived, missing, unreachable, and non-canonical documents", async () => {
    const archived = vi.fn(async () => [
      {
        id: "archived",
        project_id: "project-1",
        display_name: "Old",
        origin_kind: "managed",
        placement_kind: "local",
        status: "draft",
        archived_at: "2026-07-16T00:00:00.000Z",
      },
    ])
    await expect(
      callDocuments(archived, "documents_open", {
        id_or_name: "archived",
        project_id: "project-1",
        session_id: "session-1",
      }),
    ).rejects.toMatchObject({ code: "document_archived", status: 410 })

    await expect(
      callDocuments(
        vi.fn(async () => []),
        "documents_open",
        {
          id_or_name: "missing",
          project_id: "project-1",
          session_id: "session-1",
        },
      ),
    ).rejects.toMatchObject({ code: "document_not_found", status: 404 })

    const unreachable = vi.fn(async (path: string) => {
      if (path.includes("archived=all"))
        return [
          {
            id: "remote",
            project_id: "project-1",
            display_name: "Remote",
            origin_kind: "managed",
            placement_kind: "hosted",
            status: "draft",
            archived_at: null,
          },
        ]
      throw Object.assign(new Error("unreachable"), { code: "document_placement_unreachable", status: 409 })
    })
    await expect(
      callDocuments(unreachable, "documents_open", {
        id_or_name: "remote",
        project_id: "project-1",
        session_id: "session-1",
      }),
    ).rejects.toMatchObject({ code: "document_placement_unreachable", status: 409 })

    const fabricated = vi.fn(async (path: string) =>
      path.includes("archived=all")
        ? [
            {
              id: "bad",
              project_id: "project-1",
              display_name: "Bad",
              origin_kind: "managed",
              placement_kind: "local",
              status: "draft",
              archived_at: null,
            },
          ]
        : { document_id: "bad", display_name: "Bad", path: "relative/plan.md" },
    )
    await expect(
      callDocuments(fabricated, "documents_open", {
        id_or_name: "bad",
        project_id: "project-1",
        session_id: "session-1",
      }),
    ).rejects.toMatchObject({ code: "document_path_invalid", status: 502 })
  })

  it("registers both tools as discovery tools even in read-only mode", () => {
    const names: string[] = []
    let openConfig: Record<string, unknown> | undefined
    registerDocumentTools((name, config) => {
      names.push(name)
      if (name === "documents_open") openConfig = config
    }, vi.fn())
    expect(names).toEqual(["documents_list", "documents_open"])
    expect(openConfig?._meta).toEqual({ "io.claxedo/session-argument": "session_id" })
  })

  it("applies current directory and session defaults to open calls", async () => {
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.includes("archived=all")) return [{ id: "document-1", display_name: "Plan", archived_at: null }]
      expect(JSON.parse(String(init?.body))).toEqual({ session_id: "session-current" })
      return { document_id: "document-1", display_name: "Plan", path: "/repo/.claxedo/plan.md" }
    })
    registerDocumentTools((name, _config, handler) => handlers.set(name, handler), request, {
      directory: "/repo",
      sessionId: "session-current",
    })

    await handlers.get("documents_open")!({ id_or_name: "claxedo://document/document-1" })
    expect(request).toHaveBeenCalledWith("/documents?directory=%2Frepo&archived=all", { method: "GET" })
  })

  it("requires one unambiguous document scope", async () => {
    const request = vi.fn()
    await expect(callDocuments(request, "documents_list", {})).rejects.toMatchObject({
      code: "document_scope_required",
      status: 400,
    })
    await expect(
      callDocuments(request, "documents_list", { project_id: "p1", directory: "/repo" }),
    ).rejects.toMatchObject({
      code: "document_scope_ambiguous",
      status: 400,
    })
    expect(request).not.toHaveBeenCalled()
  })
})
