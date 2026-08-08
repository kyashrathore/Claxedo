import { createOneShotNativeRenderer } from "./native-renderer"

const maxSourceBytes = 1024 * 1024
const maxHtmlBytes = 8 * 1024 * 1024
const defaultTimeoutMs = 1_000

export function createNativeMarkdownRenderer(
  path = process.env.CLAXEDO_MARKDOWN_RENDERER_PATH,
  options: { args?: string[]; timeoutMs?: number } = {},
) {
  return createOneShotNativeRenderer({
    name: "Native Markdown renderer",
    path,
    args: options.args ?? ["markdown"],
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    maxSourceBytes,
    maxOutputBytes: maxHtmlBytes,
    serialize: (source) => JSON.stringify({ source }),
  })
}
