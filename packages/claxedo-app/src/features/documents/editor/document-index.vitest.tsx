import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { beforeEach, describe, expect, test, vi } from "vitest"

const api = vi.hoisted(() => ({
  create: vi.fn(),
  createFromRepository: vi.fn(),
  list: vi.fn(),
  listStatuses: vi.fn(),
  watch: vi.fn(),
}))

vi.mock("../data/documents-api", () => ({ documentsApi: api }))

import { PageIndex } from "./document-index"

describe("PageIndex repository indexing", () => {
  beforeEach(() => {
    api.create.mockReset()
    api.createFromRepository.mockReset()
    api.list.mockReset().mockResolvedValue([])
    api.listStatuses.mockReset().mockResolvedValue([])
    api.watch.mockReset().mockImplementation(() => new Promise(() => undefined))
  })

  test("prevents duplicate managed creates while one request is pending", async () => {
    let resolveCreate!: (document: { id: string; display_name: string; project_id: string }) => void
    api.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )
    const onOpenPage = vi.fn()
    render(() => (
      <PageIndex
        scope="project"
        directory="/repo"
        projects={[{ id: "project_1", worktree: "/repo", workspaceId: "workspace_1" }]}
        onOpenPage={onOpenPage}
      />
    ))
    const create = await screen.findByRole("button", { name: "New document" })

    fireEvent.click(create)
    fireEvent.click(create)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(create).toBeDisabled()

    const document = { id: "document_1", display_name: "Untitled document", project_id: "project_1" }
    resolveCreate(document)
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledWith(document))
    expect(create).toBeEnabled()
  })

  test("ignores an old-scope repository import completion", async () => {
    let resolveImport!: (document: { id: string; display_name: string; project_id: string }) => void
    api.createFromRepository.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve
        }),
    )
    const onOpenPage = vi.fn()
    const [config, setConfig] = createSignal({
      directory: "/repo/one",
      projects: [{ id: "project_1", worktree: "/repo/one", workspaceId: "workspace_1" }],
    })
    render(() => (
      <PageIndex scope="project" directory={config().directory} projects={config().projects} onOpenPage={onOpenPage} />
    ))
    fireEvent.click(await screen.findByRole("button", { name: "Add to Documents" }))
    fireEvent.input(screen.getByRole("textbox", { name: "Repository Markdown path" }), {
      target: { value: "docs/old.md" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add document" }))
    await waitFor(() => expect(api.createFromRepository).toHaveBeenCalledTimes(1))

    setConfig({
      directory: "/repo/two",
      projects: [{ id: "project_2", worktree: "/repo/two", workspaceId: "workspace_2" }],
    })
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ projectId: "project_2", directory: "/repo/two" }))
    resolveImport({ id: "old_document", display_name: "Old", project_id: "project_1" })
    await Promise.resolve()
    await Promise.resolve()

    expect(onOpenPage).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog", { name: "Add repository document" })).not.toBeInTheDocument()
  })

  test("ignores managed create completion after unmount", async () => {
    let resolveCreate!: (document: { id: string; display_name: string; project_id: string }) => void
    api.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )
    const onOpenPage = vi.fn()
    const view = render(() => (
      <PageIndex
        scope="project"
        directory="/repo"
        projects={[{ id: "project_1", worktree: "/repo", workspaceId: "workspace_1" }]}
        onOpenPage={onOpenPage}
      />
    ))
    fireEvent.click(await screen.findByRole("button", { name: "New document" }))
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    view.unmount()
    resolveCreate({ id: "late_document", display_name: "Late", project_id: "project_1" })
    await Promise.resolve()
    await Promise.resolve()

    expect(onOpenPage).not.toHaveBeenCalled()
  })

  test("indexes a relative Markdown file and opens the returned document", async () => {
    const document = { id: "document_1", display_name: "Plan", project_id: "project_1" }
    api.createFromRepository.mockResolvedValue(document)
    const onOpenPage = vi.fn()
    render(() => (
      <PageIndex
        scope="project"
        directory="/repo"
        projects={[
          {
            id: "project_1",
            worktree: "/repo",
            workspaces: { "/repo": { workspaceId: "workspace_1" } },
          },
        ]}
        onOpenPage={onOpenPage}
      />
    ))

    fireEvent.click(await screen.findByRole("button", { name: "Add to Documents" }))
    const input = screen.getByRole("textbox", { name: "Repository Markdown path" })
    fireEvent.input(input, { target: { value: "docs/plan.md" } })
    fireEvent.click(screen.getByRole("button", { name: "Add document" }))

    await waitFor(() =>
      expect(api.createFromRepository).toHaveBeenCalledWith({
        projectId: "project_1",
        directory: "/repo",
        workspaceId: "workspace_1",
        path: "docs/plan.md",
        displayName: "plan.md",
      }),
    )
    expect(onOpenPage).toHaveBeenCalledWith(document)
  })

  test("shows validation errors without calling the API", async () => {
    render(() => (
      <PageIndex
        scope="project"
        directory="/repo"
        projects={[{ id: "project_1", worktree: "/repo", workspaceId: "workspace_1" }]}
        onOpenPage={() => undefined}
      />
    ))
    fireEvent.click(await screen.findByRole("button", { name: "Add to Documents" }))
    fireEvent.input(screen.getByRole("textbox", { name: "Repository Markdown path" }), {
      target: { value: "../secret.md" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add document" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("relative path")
    expect(api.createFromRepository).not.toHaveBeenCalled()
  })

  test("uses the matching project and arbitrary workspace-map entry for signed repository scope", async () => {
    api.createFromRepository.mockResolvedValue({ id: "document_2" })
    render(() => (
      <PageIndex
        scope="project"
        directory="/remote/repo"
        projects={[
          { id: "wrong", worktree: "/other", workspaceId: "wrong-workspace" },
          {
            id: "project_signed",
            worktree: "/local/repo",
            workspaces: {
              alias: { directory: "/remote/repo", workspaceId: "workspace_signed", kind: "cloud" },
            },
          },
        ]}
        onOpenPage={() => undefined}
      />
    ))
    fireEvent.click(await screen.findByRole("button", { name: "Add to Documents" }))
    fireEvent.input(screen.getByRole("textbox", { name: "Repository Markdown path" }), {
      target: { value: "docs/signed.md" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add document" }))

    await waitFor(() =>
      expect(api.createFromRepository).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project_signed",
          directory: "/remote/repo",
          workspaceId: "workspace_signed",
        }),
      ),
    )
    expect(api.list).toHaveBeenCalledWith({ projectId: "project_signed", directory: "/remote/repo" })
  })

  test("fails closed when directory-only signed scope has no authoritative project mapping", async () => {
    render(() => (
      <PageIndex
        scope="project"
        directory="/remote/missing"
        projects={[{ id: "project_1", worktree: "/repo", workspaceId: "workspace_1" }]}
        onOpenPage={() => undefined}
      />
    ))
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a project")
    expect(screen.getByRole("button", { name: "Add to Documents" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "New document" })).toBeDisabled()
    expect(api.list).not.toHaveBeenCalled()
  })

  test("starts from delayed inventory and imports with the resolved signed identities", async () => {
    const [projects, setProjects] = createSignal<Parameters<typeof PageIndex>[0]["projects"]>([])
    api.createFromRepository.mockResolvedValue({ id: "document_delayed" })
    render(() => (
      <PageIndex scope="project" directory="/remote/delayed" projects={projects()} onOpenPage={() => undefined} />
    ))

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a project")
    expect(api.list).not.toHaveBeenCalled()
    setProjects([
      {
        id: "project_delayed",
        worktree: "/local/delayed",
        workspaces: {
          signed: { directory: "/remote/delayed", workspaceId: "workspace_delayed", kind: "user-hosted" },
        },
      },
    ])

    await waitFor(() =>
      expect(api.list).toHaveBeenCalledWith({
        projectId: "project_delayed",
        directory: "/remote/delayed",
      }),
    )
    expect(api.listStatuses).toHaveBeenCalledWith({ projectId: "project_delayed", directory: "/remote/delayed" })
    expect(api.watch).toHaveBeenCalledWith(
      { projectId: "project_delayed", directory: "/remote/delayed" },
      expect.any(Function),
      expect.any(AbortSignal),
    )
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "New document" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Add to Documents" })).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Add to Documents" }))
    fireEvent.input(screen.getByRole("textbox", { name: "Repository Markdown path" }), {
      target: { value: "docs/delayed.md" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add document" }))
    await waitFor(() =>
      expect(api.createFromRepository).toHaveBeenCalledWith({
        projectId: "project_delayed",
        directory: "/remote/delayed",
        workspaceId: "workspace_delayed",
        path: "docs/delayed.md",
        displayName: "delayed.md",
      }),
    )
  })

  test("switches project scope, aborts the old watcher, and ignores its stale list", async () => {
    let resolveOld!: (documents: Array<Record<string, unknown>>) => void
    const oldList = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveOld = resolve
    })
    const current = {
      id: "current",
      display_name: "Current document",
      project_id: "project_2",
      origin_kind: "managed",
      repository_relative_path: null,
      status: "draft",
    }
    api.list.mockImplementation((query: { projectId?: string }) =>
      query.projectId === "project_1" ? oldList : Promise.resolve([current]),
    )
    const watcherSignals: AbortSignal[] = []
    api.watch.mockImplementation((_query, _onEvent, signal: AbortSignal) => {
      watcherSignals.push(signal)
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    })
    const [config, setConfig] = createSignal({
      directory: "/repo/one",
      projects: [{ id: "project_1", worktree: "/repo/one", workspaceId: "workspace_1" }],
    })
    render(() => (
      <PageIndex
        scope="project"
        directory={config().directory}
        projects={config().projects}
        onOpenPage={() => undefined}
      />
    ))
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ projectId: "project_1", directory: "/repo/one" }))
    await waitFor(() => expect(watcherSignals).toHaveLength(1))

    setConfig({
      directory: "/repo/two",
      projects: [{ id: "project_2", worktree: "/repo/two", workspaceId: "workspace_2" }],
    })
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ projectId: "project_2", directory: "/repo/two" }))
    await waitFor(() => expect(watcherSignals).toHaveLength(2))
    expect(watcherSignals[0]?.aborted).toBe(true)
    expect(watcherSignals[1]?.aborted).toBe(false)
    expect(await screen.findByText("Current document")).toBeInTheDocument()

    resolveOld([
      {
        ...current,
        id: "old",
        display_name: "Stale document",
        project_id: "project_1",
      },
    ])
    await Promise.resolve()
    expect(screen.queryByText("Stale document")).not.toBeInTheDocument()
    expect(screen.getByText("Current document")).toBeInTheDocument()
    expect(api.watch).toHaveBeenCalledTimes(2)
  })
})
