/**
 * Single source of truth for the "heavy dep must not ride the eager boot chunk"
 * guardrail. Consumed by BOTH:
 *
 *   - scripts/check-forbidden-eager-deps.ts   (static import-graph check — fast, no build)
 *   - scripts/check-main-chunk-markers.ts      (build-artifact check — greps emitted main chunk)
 *
 * WHY TWO CHECKS: the static check catches a regression the moment someone adds a
 * `import "@xterm/xterm"` on the boot path, with no build needed (good for `typecheck`/
 * pre-commit). The build-artifact check is the ground truth — it greps the actually-
 * emitted entry chunk for library-internal symbols, catching cases the static walker
 * can't see (a dep pulled transitively through a node_module that re-exports, a vite
 * plugin transform, a manualChunks misconfig). A dep is only truly "out" when BOTH pass.
 *
 * Provenance: the forbidden list and the marker symbols below are derived from the
 * bundle-leak audit (docs note: app-shell rewrite, eager-main weight reduction). Each
 * entry records est. gzip saved so CI failures are self-explaining.
 */

export type ForbiddenDep = {
  /** Human label shown in failure output. */
  label: string
  /**
   * Bare module specifiers that must NOT be statically reachable from the boot
   * graph (main.tsx) without crossing a `lazy(() => import(...))` / dynamic-import
   * boundary. Matched against the *resolved* bare specifier of an import edge.
   * A specifier ending in `/` is treated as a prefix (scope/subpath) match.
   */
  specifiers: string[]
  /**
   * Distinctive library-INTERNAL identifiers that survive minification and appear
   * in the emitted entry chunk iff the library's runtime body was bundled into it.
   * These are intentionally NOT the package name (the package name shows up as a
   * harmless string ref even when only a dynamic-import trigger is present).
   * The check fails if ANY of these appears in the entry chunk.
   *
   * Empty array => no reliable build-artifact marker (rely on static check only).
   */
  markers: string[]
  /** Rough gzip weight this dep adds to the eager chunk, for failure messaging. */
  estGzip: string
  /**
   * Optional note rendered on failure: where the fix lives / how it was deferred.
   */
  fixHint?: string
  /**
   * Which static graph the dep must be absent from:
   *
   *   - "entry-chunk" (default): the graph rooted at main.tsx only — the code
   *     that runs before ANY dynamic import resolves.
   *   - "boot-closure": additionally the chunks the authenticated app awaits
   *     before first paint (preloadRuntimeProviders() in app/entry/app.tsx:
   *     runtime-providers → feature-ports + secondary-feature-ports →
   *     app-shell-bootstrap). Those are separate chunks, but they all load and
   *     evaluate at boot, so a heavy dep in them still delays first paint.
   *
   * "boot-closure" is strictly wider. It is opt-in per dep because some deps on
   * this list are known to still ride boot-time chunks through seams owned by
   * other workstreams (e.g. pierre/shiki via directory-scope → session-kit);
   * widening the scope for those would fail CI on pre-existing chains.
   */
  scope?: "entry-chunk" | "boot-closure"
}

/**
 * The forbidden set. Keep specifiers and markers narrow enough that they only fire
 * on the real library body, never on first-party wrapper modules that merely
 * dynamic-import the lib (e.g. mermaid-block.ts does `import("mermaid")` — that is
 * allowed, so "mermaid" the *string* is NOT a marker; only engine internals are).
 */
export const FORBIDDEN_DEPS: ForbiddenDep[] = [
  {
    label: "@xterm/xterm (terminal core + statically-imported addons)",
    specifiers: [
      "@xterm/xterm",
      "@xterm/addon-fit",
      "@xterm/addon-clipboard",
      "@xterm/addon-unicode11",
      "@xterm/addon-serialize",
    ],
    // xterm minifies addon class names away, but its dependency-injection service
    // identifiers and the `xterm-` CSS class prefix survive minification and are
    // distinctive to the terminal core body (verified present when xterm leaks).
    markers: ["xterm-", "RenderService", "CharSizeService", "BufferService"],
    estGzip: "~106 KB gz",
    fixHint:
      "keep TerminalContent behind the lazy surface registration in app/integrations/first-party-content-surfaces.tsx.",
  },
  {
    label: "@tiptap/* + prosemirror (page editor)",
    specifiers: [
      "@tiptap/core",
      "@tiptap/suggestion",
      "@tiptap/extension-code-block",
      "@tiptap/pm",
      "@tiptap/pm/state",
      "@tiptap/pm/view",
      "prosemirror-state",
      "prosemirror-view",
      "prosemirror-model",
    ],
    // Runtime markers verified present when tiptap leaks: the suggestion plugin key
    // ctor and the Extension.create option name for the slash-commands extension.
    markers: ['name:"slashCommands"', "addOptions", "ProseMirror"],
    estGzip: "~25-40 KB gz",
    fixHint:
      "lazify the PageContent renderer in first-party-content-surfaces.tsx, OR move " +
      "SlashCommands + MermaidCodeBlock into page-editor.tsx loadTiptap() Promise.all.",
  },
  {
    label: "katex + marked-katex-extension (math render)",
    specifiers: ["katex", "marked-katex-extension"],
    // katex internal API surface that survives minification.
    markers: ["ParseError", "buildExpression", "renderToString"],
    estGzip: "~151 KB gz (katex alone)",
    fixHint:
      "make `import katex` in packages/ui/src/context/marked.tsx lazy (load on first " +
      "math render via `await import('katex')` inside renderMathExpressions).",
  },
  {
    label: "marked (markdown parser — jsParser is dead in cloud/native-parser mode)",
    specifiers: ["marked"],
    markers: ["Tokenizer", "Lexer"],
    estGzip: "~12-14 KB gz",
    scope: "boot-closure",
    fixHint:
      "build jsParser lazily inside the `if (!props.nativeParser)` branch of marked.tsx " +
      "so `import { marked }` / `import markedKatex` become dynamic.",
  },
  {
    label: "mermaid (diagram engine)",
    specifiers: ["mermaid"],
    // No reliable build-artifact marker: the mermaid engine is correctly lazy
    // (mermaid-block.ts does `import("mermaid")`), so the only "mermaid" strings in
    // main are the dynamic-import chunk filename ("mermaid.core-*.js") and CSS class
    // names — BENIGN, and using them would false-positive on the allowed lazy state.
    // The static check already guarantees no *static* edge to the lib; rely on it.
    markers: [],
    estGzip: "~120 KB gz",
    fixHint:
      "mermaid is already lazy via mermaid-block.ts `import('mermaid')`; if this fires, " +
      "a new static edge to the lib was introduced — revert it.",
  },
  {
    label: "qrcode",
    specifiers: ["qrcode"],
    // qrcode mangles to no stable identifier; rely on the static check. No marker.
    markers: [],
    estGzip: "~8-15 KB gz",
    fixHint:
      "dynamic-import inside settings-remote-access.tsx QR effect: " +
      "`const { default: QRCode } = await import('qrcode')`.",
  },
  {
    label: "@pierre/diffs + shiki (diff renderer + syntax highlighter)",
    specifiers: ["@pierre/diffs", "shiki", "@shikijs/"],
    markers: ["FileRenderer", "DiffHunksRenderer"],
    estGzip: "~97 KB gz (pierre ~51 + shiki ~46)",
    scope: "boot-closure",
    fixHint:
      "an eager module is importing the @/ui/session-kit barrel (its export * lines reach " +
      "session-ui file/markdown/message-part, whose bodies pull pierre+shiki). Eager code must " +
      "use the light boundaries instead: @/ui/session-kit-prompt for the composer engine, " +
      "useFileComponent() (app.tsx lazy File provider) for file/diff renders, and " +
      "session-kit-loaders loadMarkdownComponent()/loadFileComponent() for on-demand renders.",
  },
  {
    label: "@tanstack/ai-client + @tanstack/ai/client (ChatClient / SSE→parts)",
    specifiers: ["@tanstack/ai-client", "@tanstack/ai/client"],
    markers: ["ChatClient", "StreamProcessor"],
    estGzip: "~22-28 KB gz",
    fixHint:
      "load @tanstack/ai-client lazily inside conversation-chat-client.ts on first " +
      "ChatClient construction; EventType must move inside that boundary too.",
  },
  {
    label: "zod (schema runtime — zod4 classic is effectively un-tree-shakable)",
    specifiers: ["zod"],
    // zod mangles its internals to no stable identifier; the static check is
    // the guard (scope "boot-closure" so it covers the pre-first-paint chunks).
    markers: [],
    estGzip: "~57 KB gz (~252 KB min)",
    scope: "boot-closure",
    fixHint:
      "boot code must not import zod statically. Existing boundaries: " +
      "app/providers/global-sdk/provider.tsx uses the plain isAbortError() predicate (no schema); " +
      "features/processes/data/client.ts lazy-loads ./process via loadProcessSchemas() on the first process API call. " +
      "Route new boot-path validation through one of those seams or a plain predicate.",
  },
  {
    label: "effect (Effect runtime — deferrable: only 3 trivial usages)",
    specifiers: ["effect"],
    // effect mangles its internals; the static check is authoritative. Leave markers
    // empty to avoid false positives on incidental 2-letter symbols.
    markers: [],
    estGzip: "~30-55 KB gz",
    fixHint:
      "rewrite ConnectionGate (app.tsx) Effect.gen as plain async; replace Schema in " +
      "directory-layout.tsx and Iterable/pipe in use-providers.ts with native code.",
  },
]

/**
 * Build-artifact allowlist: marker strings that are KNOWN to appear in the entry
 * chunk for benign reasons (e.g. a dynamic-import trigger comment, a CSS class name).
 * If a forbidden marker is genuinely unavoidable in main and that is accepted, add it
 * here WITH a justification comment so the build-artifact check stops failing on it.
 * The static check has no allowlist by design — a static eager edge is always a bug.
 */
export const BUILD_MARKER_ALLOWLIST: string[] = [
  // conversation-chat-client.ts's lazy boundary names the property it re-exposes
  // (`{ ChatClient: mod.ChatClient }`) and constructs `new runtime.ChatClient(...)`,
  // so the identifier appears in main as a dynamic-import trigger. The library
  // BODY is still guarded by the "StreamProcessor" marker, which only exists in
  // @tanstack/ai-client's own code.
  "ChatClient",
]
