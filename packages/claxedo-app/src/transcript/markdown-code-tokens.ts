import { reportUiError } from "@/ui/utils"
import { codeTheme } from "./code-theme"
import { codeThemeName } from "./code-theme-name"
import { codeLanguageName } from "./markdown-blocks"
import { getCachedCodeHighlight, highlightCodeThroughCache } from "./markdown-code-cache"
import {
  highlightStreamingCode,
  MarkdownWorkerDisposedError,
  MarkdownWorkerSupersededError,
  MarkdownWorkerUnavailableError,
} from "./markdown-worker"
import type { MarkdownToken } from "./markdown-worker-protocol"

export const highlightedCodeTokenLimit = 800

export async function highlightCode(text: string, language: string | undefined, key: string, complete = false) {
  const name = codeLanguageName(language)
  try {
    return await highlightCodeThroughCache(text, name, codeTheme.name, complete, async () => {
      const result = await highlightStreamingCode(key, text, name, complete)
      return { language: name, generation: result.generation, stable: result.stable, unstable: result.unstable }
    })
  } catch (error) {
    if (
      !(error instanceof MarkdownWorkerDisposedError) &&
      !(error instanceof MarkdownWorkerSupersededError) &&
      !(error instanceof MarkdownWorkerUnavailableError)
    )
      reportUiError(error, "markdown-highlight")
    return { language: name, generation: 0, stable: [], unstable: [[text, ""] as MarkdownToken] }
  }
}

export function createTokenSpan(token: MarkdownToken) {
  const span = document.createElement("span")
  span.setAttribute("style", token[1])
  span.textContent = token[0]
  return span
}

const painted = new WeakMap<HTMLElement, string>()

function nestedCode(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-component="markdown-code"] > pre > code'))
}

function languageOf(code: HTMLElement) {
  return code.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
}

function paint(code: HTMLElement, text: string, tokens: readonly MarkdownToken[]) {
  painted.set(code, text)
  if (tokens.length > highlightedCodeTokenLimit) return
  code.replaceChildren(...tokens.map(createTokenSpan))
}

export function paintCachedNestedCode(root: ParentNode) {
  for (const code of nestedCode(root)) {
    const text = code.textContent ?? ""
    if (painted.get(code) === text) continue
    const cached = getCachedCodeHighlight(text, codeLanguageName(languageOf(code)), codeThemeName)
    if (cached) paint(code, text, [...cached.stable, ...cached.unstable])
  }
}

export function highlightNestedCode(root: ParentNode, key: string) {
  nestedCode(root).forEach((code, index) => {
    const text = code.textContent ?? ""
    if (painted.get(code) === text) return
    void highlightCode(text, languageOf(code), `${key}:${index}`, true).then((result) => {
      if (!code.isConnected || code.textContent !== text || painted.get(code) === text) return
      paint(code, text, [...result.stable, ...result.unstable])
    })
  })
}
