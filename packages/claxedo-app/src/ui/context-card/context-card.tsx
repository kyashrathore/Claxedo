import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Show, type JSX } from "solid-js"
import "./context-card.css"

/**
 * Codex/Cursor-style contextual card — the shared shell for quiet, glanceable
 * side context (WorkGraph's "Needs you", the session's Environment card).
 * Placement copies Codex's pinned summary: the card sits INLINE in a right
 * gutter its surface reserves inside the scroll container (content squeezes
 * left, the scrollbar stays on the pane edge, the card is bounded — never a
 * full-height sidebar, never floating over content). Cursor's collapse-to-rail
 * stays: `collapsed` folds the card into a vertical icon rail in the same
 * gutter.
 *
 * The shell owns the LOOK: a chromeless block when `variant="inline"` (muted
 * label over plain rows on the page background), the system floating-surface
 * recipe when `variant="floating"`, and the collapsed rail chip. The consumer
 * owns PLACEMENT (sticky/fixed coordinates, width) via the `class` it passes,
 * and the rows it renders as children — e.g.:
 *
 *   <ContextCard variant="floating" label="Environment" ariaLabel="Session environment">
 *     <ContextCardSection label="Subagents">…rows…</ContextCardSection>
 *     <ContextCardSection label="Browser">…rows…</ContextCardSection>
 *   </ContextCard>
 */
export function ContextCard(props: {
  variant: "inline" | "floating"
  /** Accessible name for the aside landmark. */
  ariaLabel: string
  /** Muted section label, and the name collapse/close controls speak. */
  label: string
  count?: number | string
  countLabel?: string
  /** Shows the red unread dot in the head and tints the collapsed chip. */
  unread?: boolean
  unreadLabel?: string
  /** Collapse to a rail (any variant). Omit onToggleCollapse to disable. */
  collapsed?: boolean
  /** The rail's content when collapsed — one small button per item (style them
   *  with `ui-context-card-rail-item`). The expand control is always appended
   *  at the rail's bottom by the shell. */
  collapsedContent?: JSX.Element
  collapsedLabel?: string
  onToggleCollapse?: () => void
  /** Close control. */
  onClose?: () => void
  closeLabel?: string
  /** Extra header controls (e.g. a settings gear), rendered before collapse/close. */
  headerActions?: JSX.Element
  /** Consumer class for placement (sticky/fixed position, width) and scoping. */
  class?: string
  children: JSX.Element
}) {
  const variantClass = () => (props.variant === "floating" ? "is-floating" : "is-inline")
  return (
    <Show
      when={!props.collapsed}
      fallback={
        <aside class={`ui-context-card is-collapsed ${variantClass()} ${props.class ?? ""}`} aria-label={props.ariaLabel}>
          {/* Cursor's icon rail: every element is a real control — one button
              per item, and the expand control always anchored at the bottom. */}
          <div class="ui-context-card-rail">
            {props.collapsedContent}
            <button
              type="button"
              class="ui-context-card-rail-item ui-context-card-rail-expand"
              aria-label={props.collapsedLabel ?? `Expand ${props.label}`}
              onClick={() => props.onToggleCollapse?.()}
            >
              <Icon name="chevron-double-left" size="small" />
            </button>
          </div>
        </aside>
      }
    >
      {/* Variant lands in the class string — a classList with a false key would
          strip an identically-named class a consumer passed via `class`. */}
      <aside class={`ui-context-card ${variantClass()} ${props.class ?? ""}`} aria-label={props.ariaLabel}>
        <div class="ui-context-card-head">
          <span class="ui-context-card-label text-text-weak">{props.label}</span>
          <span class="ui-context-card-gap" aria-hidden="true" />
          <Show when={props.unread}>
            <span role="img" class="ui-context-card-dot" aria-label={props.unreadLabel ?? "unread"} />
          </Show>
          <Show when={props.count !== undefined}>
            <span class="ui-context-card-count text-text-base" aria-label={props.countLabel}>
              {props.count}
            </span>
          </Show>
          {props.headerActions}
          {/* Capabilities are prop-driven, independent of the look: collapse
              exists when onToggleCollapse is given, close when onClose is. */}
          <Show when={props.onToggleCollapse}>
            <IconButton
              variant="ghost"
              size="small"
              icon="chevron-double-right"
              aria-label={`Collapse ${props.label}`}
              onClick={() => props.onToggleCollapse?.()}
            />
          </Show>
          <Show when={props.onClose}>
            <IconButton
              variant="ghost"
              size="small"
              icon="close"
              aria-label={props.closeLabel ?? `Close ${props.label}`}
              onClick={() => props.onClose?.()}
            />
          </Show>
        </div>
        {props.children}
      </aside>
    </Show>
  )
}

/** A labeled sub-section inside one card (Codex's Environment / Subagents /
 *  Browser stack). Sections separate with space and a muted label, no rules. */
export function ContextCardSection(props: { label: string; children: JSX.Element }) {
  return (
    <section class="ui-context-card-section" aria-label={props.label}>
      <div class="ui-context-card-section-label text-text-weak">{props.label}</div>
      {props.children}
    </section>
  )
}

/** A generic card row: glyph + label + trailing meta, with the standard hover
 *  wash when selectable. Consumers with richer rows (WorkGraph's WaitingRow)
 *  can keep their own row component — the shell doesn't care. */
export function ContextCardRow(props: {
  glyph?: JSX.Element
  label: JSX.Element
  meta?: JSX.Element
  onSelect?: (element: HTMLButtonElement) => void
}) {
  const body = (
    <>
      <Show when={props.glyph}>
        <span class="ui-context-card-row-glyph" aria-hidden="true">
          {props.glyph}
        </span>
      </Show>
      <span class="ui-context-card-row-label text-text-base">{props.label}</span>
      <span class="ui-context-card-gap" aria-hidden="true" />
      <Show when={props.meta}>
        <span class="ui-context-card-row-meta text-text-weaker">{props.meta}</span>
      </Show>
    </>
  )
  return (
    <Show when={props.onSelect} fallback={<div class="ui-context-card-row">{body}</div>}>
      <button type="button" class="ui-context-card-row is-selectable" onClick={(event) => props.onSelect?.(event.currentTarget)}>
        {body}
      </button>
    </Show>
  )
}

/** Re-exported so consumers building chips/rows don't need a second import. */
export { Icon as ContextCardIcon }
