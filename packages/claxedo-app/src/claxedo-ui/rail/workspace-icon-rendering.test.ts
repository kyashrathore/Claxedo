/**
 * Workspace Icon Rendering Tests (DOM)
 *
 * Uses real bootstrap API data to verify cloud workspaces render cloud icons.
 * Test helpers mirror the CURRENT production code in rail-sidebar.tsx
 * (allWorkspaceItems) which is what the workspace selector dropdown uses.
 *
 * Pattern: packages/app/src/components/prompt-input/editor-dom.test.ts
 */
import { describe, expect, test, afterEach } from "bun:test"
import { getFilename } from "@/utils/path"

// ── Types (match rail-sidebar.tsx) ──

type WorkspaceInfo = { kind: "local" | "cloud"; workspace_name?: string; provider?: string }

type ProjectItem = {
  id: string
  worktree: string
  name?: string
  sandboxes?: string[]
  workspaces?: Record<string, WorkspaceInfo>
}

// ── Real bootstrap API data ──

const REAL_PROJECT: ProjectItem = {
  id: "1cb37d5f-d750-4903-a8ef-e86bc94c599b",
  worktree: "/Users/yashvardhansingh/test/opencode",
  name: "Claxedo",
  sandboxes: [
    "workspace:ws_cloud_main",
  ],
  workspaces: {
    "/Users/yashvardhansingh/test/opencode": {
      kind: "local",
      workspace_name: undefined,
    },
    "workspace:ws_cloud_main": {
      kind: "cloud",
      workspace_name: "main",
      provider: "daytona",
    },
  },
}

// server.isLocal() = true on user's machine
const IS_SERVER_LOCAL = true

// ── Production logic mirror: rail-sidebar.tsx (allWorkspaceItems) ──
// This is the ACTUAL code path that builds items for the workspace selector dropdown.
//
// DRIFT RISK: If rail-sidebar.tsx allWorkspaceItems() changes its cloud/label
// logic, this mirror must be updated. Grep for "allWorkspaceItems" across tests.

type WorkspaceSelectorItem = {
  id: string
  name: string
  directory: string
  projectId: string
  projectName: string
  isMain: boolean
  isCloud: boolean
}

function allWorkspaceItems(projects: ProjectItem[], isServerLocal: boolean): WorkspaceSelectorItem[] {
  const list: WorkspaceSelectorItem[] = []
  for (const p of projects) {
    const pName = p.name ?? getFilename(p.worktree)
    const mainWs = p.workspaces?.[p.worktree]
    const mainIsCloud = mainWs ? mainWs.kind === "cloud" : !isServerLocal
    list.push({
      id: p.worktree,
      name: "main",
      directory: p.worktree,
      projectId: p.id,
      projectName: pName,
      isMain: true,
      isCloud: mainIsCloud,
    })
    for (const s of p.sandboxes ?? []) {
      if (s === p.worktree) continue
      const ws = p.workspaces?.[s]
      const rawName = ws?.workspace_name ?? getFilename(s)
      const sbIsCloud = ws ? ws.kind === "cloud" : !isServerLocal
      list.push({
        id: s,
        name: sbIsCloud && rawName === "main" ? "main (cloud)" : rawName,
        directory: s,
        projectId: p.id,
        projectName: pName,
        isMain: false,
        isCloud: sbIsCloud,
      })
    }
  }
  return list
}

// ── DOM rendering (matches rail-sidebar.tsx) ──

function renderDropdown(items: WorkspaceSelectorItem[]): HTMLDivElement {
  const container = document.createElement("div")
  for (const ws of items) {
    const row = document.createElement("button")
    row.dataset.testid = "ws-selector-item"
    row.dataset.directory = ws.directory

    const icon = document.createElement("div")
    icon.dataset.icon = ws.isCloud ? "cloud" : "laptop"
    row.appendChild(icon)

    const label = document.createElement("span")
    label.dataset.testid = "ws-name"
    label.textContent = ws.name
    row.appendChild(label)

    container.appendChild(row)
  }
  return container
}

// ── Tests ──

let container: HTMLDivElement

afterEach(() => {
  container?.remove()
})

describe("workspace selector dropdown — real data", () => {
  test("cloud sandbox must show cloud icon, not laptop", () => {
    const items = allWorkspaceItems([REAL_PROJECT], IS_SERVER_LOCAL)
    container = renderDropdown(items)
    document.body.appendChild(container)

    const rows = container.querySelectorAll("[data-testid='ws-selector-item']")
    expect(rows.length).toBe(2)

    // Second row is the cloud sandbox
    const sandboxIcon = rows[1].querySelector("[data-icon]")!
    expect(sandboxIcon.getAttribute("data-icon")).toBe("cloud")
  })

  test("cloud sandbox must show workspace_name from metadata, not directory basename", () => {
    const items = allWorkspaceItems([REAL_PROJECT], IS_SERVER_LOCAL)
    container = renderDropdown(items)
    document.body.appendChild(container)

    const names = container.querySelectorAll("[data-testid='ws-name']")
    const sandboxName = names[1].textContent

    // Should use workspace_name "main" (displayed as "main (cloud)") from metadata,
    // not getFilename() which gives just "main" (duplicate of local)
    expect(sandboxName).toBe("main (cloud)")
  })
})

// ── Sidebar project header icon — rail-sidebar.tsx:788 ──

/**
 * Mirror of rail-sidebar.tsx projectHasCloud() + icon at line 794
 * FIXED: checks workspace metadata, falls back to server flag
 *
 * DRIFT RISK: If rail-sidebar.tsx changes cloud detection logic, update here.
 */
function sidebarProjectHeaderIcon(isServerLocal: boolean, project: ProjectItem): "cloud" | "laptop" {
  const ws = project.workspaces
  if (!ws) return isServerLocal ? "laptop" : "cloud"
  const hasCloud = Object.values(ws).some((w) => w.kind === "cloud")
  return hasCloud ? "cloud" : "laptop"
}

function renderSidebarHeader(project: ProjectItem, isServerLocal: boolean): HTMLDivElement {
  const header = document.createElement("div")
  header.dataset.testid = "sidebar-project-header"

  const label = document.createElement("span")
  label.textContent = project.name ?? getFilename(project.worktree)
  header.appendChild(label)

  const icon = document.createElement("div")
  icon.dataset.icon = sidebarProjectHeaderIcon(isServerLocal, project)
  header.appendChild(icon)

  return header
}

describe("sidebar project header icon — real data", () => {
  test("project with cloud workspace must show cloud icon, not laptop", () => {
    container = renderSidebarHeader(REAL_PROJECT, IS_SERVER_LOCAL)
    document.body.appendChild(container)

    const icon = container.querySelector("[data-icon]")!
    expect(icon.getAttribute("data-icon")).toBe("cloud")
  })
})
