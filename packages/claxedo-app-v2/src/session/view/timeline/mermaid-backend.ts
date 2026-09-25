type MermaidRenderer = (source: string, theme?: Record<string, string>) => Promise<string>

export function createMermaidBackend(input: {
  nativeRenderer?: MermaidRenderer
  fallback: (source: string) => Promise<string>
  theme: () => Record<string, string>
}) {
  if (!input.nativeRenderer) return input.fallback
  return async (source: string) =>
    input.nativeRenderer!(source, input.theme()).catch((error: unknown) => {
      console.warn("The native mermaid renderer failed; the web renderer draws the diagram", { error })
      return input.fallback(source)
    })
}
