type MermaidRenderer = (source: string, theme?: Record<string, string>) => Promise<string>

export function createMermaidBackend(input: {
  nativeRenderer?: MermaidRenderer
  fallback: (source: string) => Promise<string>
  theme: () => Record<string, string>
}) {
  if (!input.nativeRenderer) return input.fallback
  return async (source: string) =>
    input.nativeRenderer!(source, input.theme()).catch(() => input.fallback(source))
}
