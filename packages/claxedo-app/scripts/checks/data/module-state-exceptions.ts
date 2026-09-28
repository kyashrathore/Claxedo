type ModuleStateException = {
  readonly file: string
  readonly binding: string
  readonly reason: string
  readonly cap?: string
}

const timeline = "src/session/view/timeline"
const transcript = "src/transcript"
const protectedCache = "the transcript's measured module cache; moves to a provider-owned store after the swap"

export const moduleStateExceptions: readonly ModuleStateException[] = [
  { file: `${timeline}/markdown-viewer.ts`, binding: "closeActiveViewer", reason: "the one full-screen table or diagram viewer open at a time" },
  { file: `${timeline}/mermaid-timeline.ts`, binding: "installed", reason: "install-once guard for the Mermaid renderer registration" },
  { file: `${timeline}/table-timeline.ts`, binding: "installed", reason: "install-once guard for the table viewer registration" },
  { file: `${timeline}/timeline-mount-cache.ts`, binding: "snapshots", reason: protectedCache, cap: "64 sessions (MAX_SESSIONS)" },
  { file: `${timeline}/turn-fold-store.ts`, binding: "turnFoldCache", reason: protectedCache, cap: "16 sessions (MAX_SESSIONS)" },
  { file: `${transcript}/basic-tool.tsx`, binding: "deferredFrame", reason: "the one animation frame that drains deferred tool bodies" },
  { file: `${transcript}/diff/file-find.ts`, binding: "hosts", reason: "the mounted find hosts the page-wide find shortcut routes to", cap: "one per mounted viewer" },
  { file: `${transcript}/diff/file-find.ts`, binding: "target", reason: "the find host the shortcut targets" },
  { file: `${transcript}/diff/file-find.ts`, binding: "current", reason: "the find host that owns the open find bar" },
  { file: `${transcript}/diff/file-find.ts`, binding: "installed", reason: "install-once guard for the page-wide find shortcut" },
  { file: `${transcript}/diff/virtualizer.ts`, binding: "cache", reason: "ref-counted shared virtualizer per scroll root", cap: "weak on the scroll root" },
  { file: `${transcript}/diff/worker.ts`, binding: "unified", reason: "the lazily built highlight worker pool for unified diffs and whole files" },
  { file: `${transcript}/diff/worker.ts`, binding: "split", reason: "the lazily built highlight worker pool for split diffs" },
  { file: `${transcript}/line-comment-styles.ts`, binding: "installed", reason: "install-once guard for the line-comment stylesheet" },
  { file: `${transcript}/image-availability.ts`, binding: "availability", reason: "one availability signal per image URL, shared by every transcript that shows it; readers subscribe from their own render scope", cap: "none: one short entry per distinct image URL for the page's life" },
  { file: `${transcript}/markdown-cache.tsx`, binding: "cache", reason: protectedCache, cap: "4096 entries and 8 MB (markdownCacheLimits)" },
  { file: `${transcript}/markdown-cache.tsx`, binding: "mermaidCache", reason: protectedCache, cap: "256 entries and 2 MB (mermaidSvgCacheLimits)" },
  { file: `${transcript}/markdown-code-cache.ts`, binding: "cache", reason: protectedCache, cap: "4096 entries and 8 MB (codeHighlightCacheLimits)" },
  { file: `${transcript}/markdown-shiki.worker.ts`, binding: "streams", reason: "worker-side highlight streams by key", cap: "deleted on dispose and completion" },
  { file: `${transcript}/markdown-shiki.worker.ts`, binding: "highlighter", reason: "the worker's one lazily created shiki highlighter" },
  { file: `${transcript}/markdown-worker.ts`, binding: "worker", reason: "the one markdown worker" },
  { file: `${transcript}/markdown-worker.ts`, binding: "disabled", reason: "why the worker stopped, so parsing falls back to the main thread" },
  { file: `${transcript}/markdown-worker.ts`, binding: "nextId", reason: "request id counter for the worker protocol" },
  { file: `${transcript}/markdown-worker.ts`, binding: "pending", reason: "requests awaiting a worker answer", cap: "deleted on answer" },
  { file: `${transcript}/markdown-worker.ts`, binding: "states", reason: "per-stream worker state", cap: "deleted on dispose" },
  { file: `${transcript}/markdown-worker.ts`, binding: "keys", reason: "live stream keys", cap: "deleted on dispose" },
  { file: `${transcript}/markdown-worker.ts`, binding: "latest", reason: "latest request id per stream", cap: "deleted on dispose" },
  { file: `${transcript}/markdown.tsx`, binding: "renderedCodeTokens", reason: "per-element highlight state for rendered code blocks", cap: "weak on the element" },
  { file: `${transcript}/markdown.tsx`, binding: "copyButtonState", reason: "per-button copy feedback state", cap: "weak on the element" },
  { file: `${transcript}/markdown.tsx`, binding: "viewButtonState", reason: "per-button full-screen view handler", cap: "weak on the element" },
  { file: `${transcript}/markdown.tsx`, binding: "mermaidRenderer", reason: "the renderer the app registers once at start" },
  { file: `${transcript}/markdown.tsx`, binding: "mermaidViewer", reason: "the full-screen diagram viewer the app registers once" },
  { file: `${transcript}/markdown.tsx`, binding: "mermaidInFlight", reason: "diagram renders in flight, shared by source", cap: "deleted when the render settles" },
  { file: `${transcript}/markdown.tsx`, binding: "markdownTableViewer", reason: "the full-screen table viewer the app registers once" },
  { file: `${transcript}/mermaid.ts`, binding: "mermaidModule", reason: "the one lazy mermaid import" },
  { file: `${transcript}/mermaid.ts`, binding: "counter", reason: "diagram id counter mermaid requires to be unique per page" },
  { file: `${transcript}/session-diff.ts`, binding: "fileDiffCache", reason: protectedCache, cap: "16 entries (diffCacheLimit)" },
  { file: `${transcript}/session-diff.ts`, binding: "fileDiffSerial", reason: "serial minted per distinct diff content for Pierre's cacheKey" },
]
