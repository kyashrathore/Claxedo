import { createOneShotNativeRenderer } from "./native-renderer"

const maxSourceBytes = 256 * 1024
const maxSvgBytes = 4 * 1024 * 1024
const defaultTimeoutMs = 2_000

export function createNativeMermaidRenderer(
  path = process.env.CLAXEDO_MERMAID_RENDERER_PATH,
  options: { args?: string[]; timeoutMs?: number } = {},
) {
  const render = createOneShotNativeRenderer({
    name: "Native Mermaid renderer",
    path,
    args: options.args ?? ["mermaid"],
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    maxSourceBytes,
    maxOutputBytes: maxSvgBytes,
    serialize: (source) => source,
    validate: (output) => output.startsWith("<svg") && output.endsWith("</svg>"),
    invalidOutputMessage: "Native Mermaid renderer returned an invalid SVG document",
  })
  if (!render) return
  return (source: string, theme: Record<string, string> = {}) =>
    render(JSON.stringify({ source, theme }))
}
