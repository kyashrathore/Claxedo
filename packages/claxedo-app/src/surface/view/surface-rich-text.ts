import { createContext, useContext, type Component } from "solid-js"

export type SurfaceRichText = {
  readonly Markdown: Component<{ text: string }>
  readonly onLinkClick: (event: MouseEvent) => void
}

const SurfaceRichTextContext = createContext<SurfaceRichText>()

export const SurfaceRichTextProvider = SurfaceRichTextContext.Provider

export function useSurfaceRichText(): SurfaceRichText | undefined {
  return useContext(SurfaceRichTextContext)
}

export function useSurfaceMarkdown(): Component<{ text: string }> {
  const richText = useSurfaceRichText()
  if (!richText) throw new Error("a surface's Markdown and Code need TranscriptKitProviders above the SurfaceView")
  return richText.Markdown
}
