/**
 * Viewport breakpoint tokens — the single source of truth for every
 * layout-gating pixel threshold in the app (WP-C3, design note
 * `docs/plans/2026-07-11-010-wp-c3-breakpoint-inventory.md`).
 *
 * The five on-scale tokens mirror Tailwind's default `screens` map
 * (`sm=640, md=768, lg=1024, xl=1280, 2xl=1536`) so a `md:`/`max-md:` utility
 * class and a hand-written `@media`/`matchMedia` boundary resolve to the same
 * width. The three `BP_EDITOR_*`/`BP_XS` tokens are deliberate exceptions that
 * are NOT on the Tailwind scale — kept named rather than forced onto the
 * nearest stock step, because rounding them would shift real trigger widths
 * (see the inventory §1 page-editor rows).
 *
 * CSS custom properties cannot be interpolated into `@media` conditions
 * (`@media (max-width: var(--bp-md))` is invalid CSS), so the `@media` rules in
 * `app-shell.css`/`ui-overrides.css`/`page-editor.css` must keep the literal
 * pixel number. `app-shell.css`'s `:root` block mirrors these values as
 * `--bp-*` custom properties (for `calc()`/inline-style use), and
 * `src/architecture/breakpoint-token-parity.guard.test.ts` is the weld that
 * keeps the scattered CSS/TS literals in lockstep with the constants below.
 */

// On the Tailwind default `screens` scale.
export const BP_SM = 640 // Tailwind `sm` — workspace-panel full-width / settings drill-down + free-drag
export const BP_MD = 768 // Tailwind `md` — workbench collapse / page-editor mobile mode / terminal DOM-renderer fallback / review-tab default diff style
export const BP_LG = 1024 // Tailwind `lg` — page-editor side-dock collapse
export const BP_XL = 1280 // Tailwind `xl` — reserved (no gate today)
export const BP_2XL = 1536 // Tailwind `2xl` — ui-overrides timeline/composer max-width restore

// Deliberately OFF the Tailwind scale — named exceptions, not forced onto the
// nearest stock step (see the inventory §1 page-editor rows).
export const BP_EDITOR_WIDE = 1200 // page-editor.css padding tier (between lg and xl)
export const BP_EDITOR_COMPACT = 900 // page-editor.css padding/actions tier (between md and lg)
export const BP_XS = 420 // page-editor.css extra-narrow-phone tier — live at the mobile iPhone-13 (390px) viewport, do NOT fold into BP_SM

/**
 * True when the viewport is narrower than the `md` collapse boundary. `width`
 * defaults to the current window width and is `undefined` on the server (so the
 * result is `false` under SSR, matching the widescreen-first default).
 */
export function isNarrowViewport(
  width: number | undefined = typeof window === "undefined" ? undefined : window.innerWidth,
): boolean {
  return width !== undefined && width < BP_MD
}

/**
 * Build a `max-width` media-query string for a token, for JS `matchMedia`/
 * `createMediaQuery` use (this string interpolation is legal — only the CSS
 * `@media` *rule* syntax cannot reference a custom property). `mediaQueryBelow(BP_MD)`
 * → `"(max-width: 767px)"`, the JS complement of the `min-width: 768px` boundary.
 */
export function mediaQueryBelow(breakpoint: number): string {
  return `(max-width: ${breakpoint - 1}px)`
}

/** Media query for touch/stylus (non-mouse) primary pointers. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)"
