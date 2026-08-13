import { ensureOpenCodeTheme } from "@opencode-ai/ui/context/marked"

export async function loadFileComponent() {
  const [module] = await Promise.all([
    import("@opencode-ai/session-ui/file"),
    ensureOpenCodeTheme(),
  ])
  return module.File
}

/**
 * Lazy edge for the session-ui Markdown renderer. markdown.tsx statically pulls
 * shiki (`bundledLanguages`) plus the highlight worker, so an eager surface that
 * needs Markdown must cross this dynamic boundary instead of importing
 * `@/ui/session-kit` (see session-context-tab.tsx).
 */
export async function loadMarkdownComponent() {
  const [module] = await Promise.all([
    import("@opencode-ai/session-ui/markdown"),
    ensureOpenCodeTheme(),
  ])
  return module.Markdown
}
