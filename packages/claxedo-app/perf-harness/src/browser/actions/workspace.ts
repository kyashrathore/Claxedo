import { measurement } from "../../isolated-interaction"
import type { Measurement } from "../../types"
import type { fixtureFor } from "../fixtures"
import { recordVisualFailure, settleForVideo, waitForAnimationFrame } from "./common"
import path from "node:path"
import type { Page } from "playwright-core"

export async function openWorkspaceFileTab(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  filePath: string,
) {
  const navigator = page.locator("[data-testid='workspace-files-navigator'][data-mode='files']").last()
  const search = navigator.locator("input[placeholder='Search files...']").first()
  if (!await search.waitFor({ state: "visible", timeout: 2_000 }).then(() => true).catch(() => false)) {
    recordVisualFailure(fixture, `Files navigator was unavailable while opening ${filePath}`)
    return
  }
  await search.fill(filePath)
  const row = navigator.locator(`[data-file-tree-path="${filePath}"]`).first()
  if (!await row.waitFor({ state: "visible", timeout: 3_000 }).then(() => true).catch(() => false)) {
    const diagnostic = await navigator.evaluate((root, filePath) => {
      const describe = (element: Element | null) => {
        if (!element) return undefined
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        // `dataset` lives on HTMLElement and SVGElement, not on Element.
        const data = element instanceof HTMLElement || element instanceof SVGElement ? element.dataset : {}
        return {
          tag: element.tagName.toLowerCase(),
          testId: data.testid,
          slot: data.slot,
          state: data.state,
          ariaHidden: element.getAttribute("aria-hidden"),
          hidden: element instanceof HTMLElement && element.hidden,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
          contentVisibility: style.contentVisibility,
          opacity: style.opacity,
          overflow: style.overflow,
        }
      }
      const exact = root.querySelector<HTMLElement>(`[data-file-tree-path="${CSS.escape(filePath)}"]`)
      const ancestors: ReturnType<typeof describe>[] = []
      for (let current = exact?.parentElement; current && current !== root; current = current.parentElement) {
        const detail = describe(current)
        if (detail?.hidden || detail?.ariaHidden === "true" || detail?.display === "none" || detail?.rect.width === 0 || detail?.rect.height === 0) {
          ancestors.push(detail)
        }
      }
      return {
        query: root.querySelector<HTMLInputElement>("input[placeholder='Search files...']")?.value,
        navigatorCount: document.querySelectorAll("[data-testid='workspace-files-navigator'][data-mode='files']").length,
        navigator: describe(root),
        row: describe(exact),
        hiddenOrZeroAncestors: ancestors.slice(0, 8),
        rows: Array.from(root.querySelectorAll<HTMLElement>("[data-file-tree-path]"))
          .slice(0, 8)
          .map((item) => item.dataset.fileTreePath),
        loading: !!root.querySelector("[data-file-tree-loading], [class*='animate-spin']"),
        text: root.textContent?.replace(/\s+/g, " ").trim().slice(0, 240),
      }
    }, filePath).catch(() => undefined)
    recordVisualFailure(fixture, `Files navigator did not return ${filePath}; state=${JSON.stringify(diagnostic)}`)
    return
  }
  await row.click({ timeout: 2_000 })
  const ready = await page.waitForFunction(({ filePath, filename }) => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    if (!shell) return false
    const selected = Array.from(shell.querySelectorAll<HTMLElement>("[data-slot='workspace-tab'][data-selected='true']"))
      .find((tab) => tab.dataset.workspaceTabKind === "file" && tab.textContent?.includes(filename))
    const selectedPath = shell.querySelector<HTMLElement>(
      `[data-testid='workspace-files-navigator'][data-mode='files'] [data-file-tree-path="${CSS.escape(filePath)}"][aria-selected='true']`,
    )
    const activeFile = shell.querySelector<HTMLElement>(
      `[data-testid='tab-file-root'][data-tab-file-path="${CSS.escape(filePath)}"][data-tab-file-state='ready']`,
    )
    if (!selected || !selectedPath || !activeFile) return false
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const loading = Array.from(shell.querySelectorAll<HTMLElement>("div, span"))
      .some((node) => visible(node) && node.children.length === 0 && node.textContent?.trim() === "Loading...")
    return visible(activeFile) && !loading
  }, { filePath, filename: path.basename(filePath) }, { timeout: 5_000 }).then(() => true).catch(() => false)
  if (!ready) recordVisualFailure(fixture, `Workspace file tab did not become ready: ${filePath}`)
}

// ---------------------------------------------------------------------------
// Isolated-interaction scenario families (workspace-lifecycle,
// workspace-interactions, session-switch-workspace). Every measured
// interaction below runs on its own clock started at a trusted pointerdown
// (or the flow's triggering event), settles behind an explicit gate before
// the next interaction starts, and reports the shared per-interaction bundle
// from isolated-interaction.ts. There are deliberately NO cumulative clocks
// across interactions.

export function workspacePanelToggle(page: Page) {
  return page.locator("[data-testid='workspace-panel-toggle']:visible").last()
}

// Untrusted in-page click: activates a control WITHOUT emitting a pointerdown,
// so a recorder armed at trusted-pointerdown keeps waiting for the phase's
// actual measured click. Optionally marks the click's page-clock time so an
// interruption phase can prove its trusted click landed inside the motion.
export async function syntheticVisibleClick(page: Page, selector: string, mark?: string) {
  await page.evaluate(({ selector, mark }) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const target = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).at(-1)
    if (!target) throw new Error(`No visible element for synthetic click: ${selector}`)
    if (mark) {
      performance.clearMarks(mark)
      performance.mark(mark)
    }
    target.click()
  }, { selector, mark: mark ?? undefined })
}

// A stationary, handler-free spot in the workbench header's empty left
// region. The interruption phases deliver their trusted pointerdown here and
// relay the activation to the workspace-panel toggle synchronously inside the
// same trusted dispatch, because the toggle itself slides with the workbench
// column's animated margin during the panel motion — a coordinate captured
// before the motion would miss it.
export async function workspaceHeaderInertPoint(page: Page) {
  const rect = await page.locator("[data-testid='workbench-shell-header']").first().boundingBox()
  if (!rect) throw new Error("workbench shell header had no bounds for the inert interruption click")
  return { x: rect.x + 60, y: rect.y + rect.height / 2 }
}

// Installs a one-shot capture listener that activates the (possibly moving)
// workspace-panel toggle synchronously inside the NEXT trusted pointerdown's
// dispatch. Registered inside the measured action, after the recorder's own
// trusted-pointerdown arm, so the toggle handler's work lands in the window.
export async function relayNextTrustedPointerdownToWorkspaceToggle(page: Page) {
  await page.evaluate((selector) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    window.addEventListener(
      "pointerdown",
      function relay(event) {
        if (!event.isTrusted) return
        window.removeEventListener("pointerdown", relay, true)
        Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(visible).at(-1)?.click()
      },
      { capture: true },
    )
  }, WORKSPACE_PANEL_TOGGLE_SELECTOR)
}

export async function waitForWorkspacePanelFullyClosed(page: Page) {
  await page.waitForFunction(() => {
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell']")
    return !shell || (
      shell.dataset.open === "false" &&
      (shell.getAttribute("aria-hidden") === "true" || getComputedStyle(shell).display === "none")
    )
  }, undefined, { timeout: 5_000 })
}

export async function waitForWorkspaceReviewContent(page: Page, expectedTotal: number, timeoutMs = 12_000) {
  await page.waitForFunction((expectedTotal) => {
    const visible = (element: Element) => {
      if (element.closest("[aria-hidden='true']")) return false
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }
    const shell = document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    if (!shell || !visible(shell) || shell.getBoundingClientRect().width <= 120) return false
    const root = Array.from(shell.querySelectorAll<HTMLElement>("[data-testid='review-pane-root']")).find(visible)
    if (!root) return false
    const corpus = root.querySelector<HTMLElement>("[data-review-rendered-files][data-review-total-files]")
    if (!corpus || Number(corpus.dataset.reviewTotalFiles ?? "0") !== expectedTotal) return false
    if (!Array.from(root.querySelectorAll<HTMLElement>("[data-review-file]")).some(visible)) return false
    return !root.querySelector("[data-testid='review-pane-loading'], [data-testid='workspace-review-pending']")
  }, expectedTotal, { timeout: timeoutMs })
}

// The same ownership-zero selectors the heavy-workspace disposal gates use.
export async function readWorkspaceClosedOwnership(page: Page) {
  return await page.evaluate(() => ({
    shells: document.querySelectorAll("[data-testid='workspace-panel-shell']").length,
    tabs: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-slot='workspace-tab']").length,
    fileRoots: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='tab-file-root']").length,
    navigators: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='workspace-files-navigator']").length,
    reviewRoots: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-testid='review-pane-root']").length,
    reviewFiles: document.querySelectorAll("[data-testid='workspace-panel-shell'] [data-review-file]").length,
  }))
}

export function workspaceOwnershipRows(prefix: string, ownership: Awaited<ReturnType<typeof readWorkspaceClosedOwnership>>): Measurement[] {
  return Object.entries(ownership).map(([name, count]) => measurement(`${prefix}_${name}`, count, "count"))
}

export const WORKSPACE_PANEL_TOGGLE_SELECTOR = "[data-testid='workspace-panel-toggle']"

export async function measureWorkspaceFiles(
  page: Page,
  fixture: ReturnType<typeof fixtureFor>,
  options: { settle?: "video" | "frame" } = {},
) {
  const result = await page.evaluate(async () => {
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none"
    }
    const present = (root: Element | null | undefined): root is Element => !!root
    const clickButton = (label: string, roots: Array<Document | Element> = [document]) => {
      const seen = new Set<HTMLElement>()
      for (const root of roots) for (const el of Array.from(root.querySelectorAll<HTMLElement>(
        `button[aria-label='${label}'], [role='button'][aria-label='${label}']`,
      ))) {
        if (seen.has(el)) continue
        seen.add(el)
        if (!visible(el)) continue
        el.click()
        return true
      }
      return false
    }
    const waitForFrameUntil = async (condition: () => boolean, timeout: number) =>
      await new Promise<boolean>((resolve) => {
        const started = performance.now()
        const tick = () => {
          if (condition()) {
            resolve(true)
            return
          }
          if (performance.now() - started > timeout) {
            resolve(false)
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    const waitClickButton = async (label: string, timeout: number) =>
      await waitForFrameUntil(() => clickButton(label, workspacePanelControlRoots()), timeout)
    const workspacePanelShell = () =>
      document.querySelector<HTMLElement>("[data-testid='workspace-panel-shell'][data-open='true']")
    const visibleByTestId = (testId: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid='${testId}']`)).filter(visible)
    const workspacePanelControlRoots = () =>
      [
        workspacePanelShell()?.querySelector("[data-testid='workspace-panel-l1-header']"),
        ...visibleByTestId("workbench-l2-header"),
        ...visibleByTestId("workspace-panel-floating-chrome"),
        workspacePanelShell(),
      ].filter(present)
    const clickWorkspacePanelToggle = () =>
      clickButton("Open workspace panel", [
        ...visibleByTestId("workspace-panel-floating-chrome"),
        workspacePanelShell()?.querySelector("[data-testid='workspace-panel-l1-header']"),
      ].filter(present))
    const fileNavigator = () =>
      document.querySelector<HTMLElement>("[data-testid='workspace-files-navigator'][data-mode='files']")
    const navigatorOpen = (navigator: HTMLElement) => {
      const overlay = navigator.closest<HTMLElement>("[data-testid='workspace-navigator-overlay']")
      if (!overlay) return visible(navigator)
      return overlay.getAttribute("data-open") === "true" && overlay.getAttribute("aria-hidden") !== "true"
    }
    const navigatorVisible = () => {
      const navigator = fileNavigator()
      if (!navigator) return false
      if (
        navigatorOpen(navigator) &&
        navigator.getAttribute("data-file-tree-shell-ready") === "true"
      ) return true
      if (!visible(navigator)) return false
      return !!navigator.querySelector("[data-component='filetree'] [data-file-tree-path], [data-component='filetree'] button, [data-component='filetree'] [data-file-tree-loading]")
    }
    const navigatorDataVisible = () => {
      const navigator = fileNavigator()
      if (!navigator) return false
      if (
        navigatorOpen(navigator) &&
        navigator.getAttribute("data-file-tree-data-ready") === "true"
      ) return true
      if (!visible(navigator)) return false
      return !!navigator.querySelector("[data-component='filetree'] [data-file-tree-path], [data-component='filetree'] button")
    }
    const started = performance.now()
    if (navigatorVisible()) return { ok: true, total: 0, control: 0, state: 0, frame: 0, data: navigatorDataVisible() ? 0 : Number.NaN }
    const controlStarted = performance.now()
    const openedFilesDirectly = clickButton("Open Files", workspacePanelControlRoots())
    if (!openedFilesDirectly && !workspacePanelShell()) {
      clickWorkspacePanelToggle()
      await waitForFrameUntil(() => !!workspacePanelShell(), 2_000)
    }
    if (!navigatorVisible() && !openedFilesDirectly) await waitClickButton("Open Files", 2_000)
    const control = performance.now() - controlStarted
    const stateStarted = performance.now()
    const ok = await waitForFrameUntil(navigatorVisible, 5_000)
    const state = performance.now() - stateStarted
    const total = performance.now() - started
    const dataStarted = performance.now()
    const hasData = await waitForFrameUntil(navigatorDataVisible, 5_000)
    const data = hasData ? performance.now() - dataStarted : Number.NaN
    return {
      ok,
      total,
      control,
      state,
      frame: total,
      data,
    }
  })
  if (!result.ok) recordVisualFailure(fixture, "workspace files navigator did not visibly render")
  if ((options.settle ?? "video") === "video") await settleForVideo(page)
  else await waitForAnimationFrame(page, 1)
  return [
    measurement("file_tree_load_ms", result.total),
    measurement("file_tree_control_ms", result.control),
    measurement("file_tree_state_ms", result.state),
    measurement("file_tree_first_frame_ms", result.frame),
    measurement("file_tree_data_ms", result.data),
  ]
}
