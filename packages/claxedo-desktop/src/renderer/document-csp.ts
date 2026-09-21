/**
 * Document CSP for the renderer's two HTML entries.
 *
 * The packaged window loads `index.local.html` / `loading.html` over `file://`,
 * where no HTTP response header can stamp a policy — the `<meta>` tag the
 * build injects from these strings is the only CSP carrier for that document.
 *
 * `connect-src` is scheme-wide because the shell connects to a user-selected
 * server: the embedded local server on 127.0.0.1, self-hosted `http://` LAN
 * installs, hosted `https://` deployments, and their `ws://`/`wss:` event
 * streams, plus PostHog analytics — an allowlist would break configured
 * servers. The directives that carry the security weight are `default-src
 * 'self'` and `script-src 'self'` (no `unsafe-inline`), which is what stops an
 * injected markup payload from running script.
 *
 * `'wasm-unsafe-eval'` is required by the Shiki highlighter's oniguruma WASM,
 * which compiles inside a web worker inheriting this policy.
 */

const PACKAGED_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  // Style attributes and library-injected <style> nodes; inline script stays
  // refused — it is the vector that matters for a document CSP.
  "style-src 'self' 'unsafe-inline'",
  // Markdown/previews render remote images; screenshots and icons use
  // data:/blob:.
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  // data:/blob: admit fetching inline resources the page already holds; they
  // are not network endpoints.
  "connect-src 'self' http: https: ws: wss: data: blob:",
  "worker-src 'self' blob:",
  // The hosted-browser pane embeds arbitrary pages in a sandboxed iframe.
  "frame-src http: https:",
  "media-src 'self' blob: http: https:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]

// The dev document is served by Vite, which injects its client script and
// transforms modules through its own pipeline — inline/eval and HMR websockets
// stay open there. Still a policy, not none: foreign schemes (file:,
// javascript:) remain refused.
const DEV_DIRECTIVES = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "connect-src 'self' http: https: ws: wss: data: blob:",
  "img-src 'self' data: blob: http: https:",
  "frame-src http: https:",
  "object-src 'none'",
  "base-uri 'none'",
]

export const PACKAGED_RENDERER_CSP = PACKAGED_DIRECTIVES.join("; ")
export const DEV_RENDERER_CSP = DEV_DIRECTIVES.join("; ")

/** `<meta http-equiv>` descriptor, for Vite's transformIndexHtml tag list. */
export function rendererCspMetaTag(content: string) {
  return {
    tag: "meta",
    attrs: { "http-equiv": "Content-Security-Policy", content },
    injectTo: "head-prepend" as const,
  }
}
