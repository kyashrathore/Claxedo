// Path handling for timeline file interactions: `@path` chips in assistant
// markdown (click-to-open, T16) and the file context menu (T11).

import {
  resolveWorkspaceFileFocus,
  type WorkspaceFileFocusTarget,
} from "@/platform/files/workspace-file-focus"

// Path chips render opencode mentions as `@path`; strip the mention sigil
// before resolving. (A path literally starting with `@` — e.g. an npm scope
// directory — is indistinguishable from a mention here; mentions win.)
export const stripMentionSigil = (raw: string) => raw.trim().replace(/^@/, "")

/**
 * Shared with the terminal's file links: normalizes `./`, relativizes
 * absolute-in-workspace paths, parses `:line[:col]` suffixes, and refuses
 * `~`/traversal/out-of-workspace paths (which used to open blank tabs).
 */
export function timelineFileFocus(
  raw: string,
  workspaceDir: string,
): WorkspaceFileFocusTarget | undefined {
  return resolveWorkspaceFileFocus(stripMentionSigil(raw), workspaceDir)
}

/** Resolve an ambiguous inline-code value against exact workspace file results. */
export async function timelineFileCandidateIsOpenable(
  raw: string,
  workspaceDir: string,
  findFiles: (query: string) => Promise<readonly string[]>,
) {
  const target = timelineFileFocus(raw, workspaceDir)
  if (!target) return false
  return exactTimelineFileMatch(target.path, workspaceDir, findFiles)
}

/** Promote inert path candidates only after an exact workspace file match. */
export function observeTimelineFileCandidates(
  root: HTMLElement,
  workspaceDir: string,
  findFiles: (query: string) => Promise<readonly string[]>,
) {
  const maxConcurrent = 8
  const maxResults = 256
  const results = new Map<string, Promise<boolean>>()
  const settled = new Set<string>()
  const pending = new WeakMap<HTMLElement, string>()
  const queued: Array<{ start: () => void; cancel: () => void }> = []
  let active = 0
  let deferred = false
  let retryScheduled = false
  let stopped = false
  const schedule = (path: string) =>
    new Promise<boolean>((resolve, reject) => {
      const task = {
        start: () => {
          if (stopped) {
            resolve(false)
            return
          }
          active += 1
          void exactTimelineFileMatch(path, workspaceDir, findFiles)
            .then(resolve, reject)
            .finally(() => {
              active -= 1
              queued.shift()?.start()
            })
        },
        cancel: () => resolve(false),
      }
      if (active < maxConcurrent) {
        task.start()
        return
      }
      queued.push(task)
    })
  const makeRoom = () => {
    if (results.size < maxResults) return true
    for (const path of settled) {
      results.delete(path)
      settled.delete(path)
      return true
    }
    deferred = true
    return false
  }
  const retryDeferred = () => {
    if (!deferred || retryScheduled || stopped) return
    deferred = false
    retryScheduled = true
    queueMicrotask(() => {
      retryScheduled = false
      if (!stopped) promoteWithin(root)
    })
  }
  const promote = (candidate: HTMLElement) => {
    const raw = candidate.textContent?.trim()
    if (!raw || pending.get(candidate) === raw) return
    const target = timelineFileFocus(raw, workspaceDir)
    if (!target) {
      pending.delete(candidate)
      delete candidate.dataset.inlineCodeKind
      return
    }
    const cached = results.get(target.path)
    if (!cached && !makeRoom()) return
    pending.set(candidate, raw)
    const result = cached ?? schedule(target.path)
    if (!cached) {
      results.set(target.path, result)
      void result.then(
        (openable) => {
          if (openable) settled.add(target.path)
          if (!openable) results.delete(target.path)
          retryDeferred()
        },
        () => {
          results.delete(target.path)
          retryDeferred()
        },
      )
    }
    void result.then(
      (openable) => {
        if (pending.get(candidate) !== raw) return
        pending.delete(candidate)
        if (stopped || !root.contains(candidate) || candidate.textContent?.trim() !== raw) return
        if (candidate.dataset.inlineCodeKind !== "path-candidate") return
        if (openable) {
          candidate.dataset.inlineCodeKind = "path"
          return
        }
        delete candidate.dataset.inlineCodeKind
      },
      () => {
        if (pending.get(candidate) !== raw) return
        pending.delete(candidate)
        if (stopped || !root.contains(candidate) || candidate.textContent?.trim() !== raw) return
        if (candidate.dataset.inlineCodeKind === "path-candidate") delete candidate.dataset.inlineCodeKind
      },
    )
  }
  const promoteWithin = (scope: ParentNode) => {
    if (scope instanceof HTMLElement && scope.dataset.inlineCodeKind === "path-candidate") promote(scope)
    for (const candidate of scope.querySelectorAll('[data-inline-code-kind="path-candidate"]')) {
      if (candidate instanceof HTMLElement) promote(candidate)
    }
  }
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target instanceof HTMLElement) {
        if (mutation.target.dataset.inlineCodeKind === "path-candidate") promote(mutation.target)
        continue
      }
      if (mutation.type === "characterData") {
        if (mutation.target.parentElement?.dataset.inlineCodeKind === "path-candidate") {
          promote(mutation.target.parentElement)
        }
        continue
      }
      if (mutation.target instanceof HTMLElement && mutation.target.dataset.inlineCodeKind === "path-candidate") {
        promote(mutation.target)
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement || node instanceof DocumentFragment) promoteWithin(node)
      }
    }
  })
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["data-inline-code-kind"],
    characterData: true,
    childList: true,
    subtree: true,
  })
  promoteWithin(root)
  return () => {
    stopped = true
    observer.disconnect()
    for (const task of queued.splice(0)) task.cancel()
  }
}

async function exactTimelineFileMatch(
  path: string,
  workspaceDir: string,
  findFiles: (query: string) => Promise<readonly string[]>,
) {
  return (await findFiles(path)).some((file) => timelineFileFocus(file, workspaceDir)?.path === path)
}

/** Absolute form for the OS-level desktop actions (Copy path / Reveal). */
export function resolveTimelinePath(raw: string, workspaceDir: string): string {
  const target = timelineFileFocus(raw, workspaceDir)
  if (!target) return stripMentionSigil(raw)
  return `${workspaceDir.replace(/\/$/, "")}/${target.path}`
}

/**
 * File-path href of a timeline markdown anchor, or undefined for genuine web
 * links. The markdown renderer marks EVERY link target="_blank" — including
 * scheme-less local paths like `[README.md](/Users/…/README.md)`, which the
 * browser resolves against the app origin and opens as a dead new tab. Links
 * with a scheme, protocol-relative links, and in-page anchors keep their
 * browser behavior.
 */
export function timelineAnchorFileHref(anchor: Element): string | undefined {
  const href = anchor.getAttribute("href") ?? ""
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return undefined
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/**
 * File href of the anchor a plain left-click targets, or undefined for
 * modifier/middle clicks and non-file anchors. Used by the capture-phase
 * handler so it can preventDefault before the browser's target="_blank"
 * new-window default action runs.
 */
export function timelineAnchorClickTarget(event: MouseEvent): string | undefined {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined
  const target = event.target instanceof Element ? event.target : null
  const anchor = target?.closest("a[href]")
  return anchor ? timelineAnchorFileHref(anchor) : undefined
}

const IMAGE_URL_PATH = /(?:\.|\/)(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i

/** External image or source-attachment URL targeted by a plain left-click. */
export function timelineExternalSourceClickTarget(event: MouseEvent): string | undefined {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined
  const target = event.target instanceof Element ? event.target : null
  const anchor = target?.closest("a[href]")
  if (!anchor) return undefined
  const href = anchor.getAttribute("href")
  if (!href) return undefined
  try {
    const url = new URL(href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (
      !target?.closest("img") &&
      !anchor.matches('[data-slot="file-part-link"]') &&
      !IMAGE_URL_PATH.test(url.pathname)
    ) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Resolve the file path a context-menu event targets. Inline-code chips carry
 * the path as their text; filename slots render only the basename — there the
 * full path travels on a `data-path` attribute set at the render sites.
 * (Falling back to slot textContent used to fabricate
 * `<workspaceDir>/<basename>` paths for Open/Copy/Reveal.)
 */
export function timelineFileTarget(target: EventTarget | null): string | undefined {
  const el = target instanceof Element ? target : null
  const chip = el?.closest('[data-inline-code-kind="path"]')
  if (chip) {
    const text = chip.textContent?.trim()
    return text || undefined
  }
  const slot =
    el?.closest('[data-slot="message-part-title-filename"]') ??
    el?.closest('[data-slot="session-turn-diff-filename"]')
  if (!slot) return undefined
  return slot.closest("[data-path]")?.getAttribute("data-path") || undefined
}
