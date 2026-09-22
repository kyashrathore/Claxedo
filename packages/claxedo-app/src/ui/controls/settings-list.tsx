import { Show, createUniqueId, type Component, type JSX } from "solid-js"

/**
 * The cards, rows and headings every Settings section is built from.
 *
 * Here rather than under `features/settings` because a section is not always
 * settings' own code: a feature contributes one, and a contributed panel that
 * hand-rolled the card ended up as the one tab that did not look like Settings.
 */

/**
 * The one card every settings section's rows sit on.
 *
 * `bg-surface-raised-base`, not `bg-surface-base`: the codex theme flattens the
 * latter to the page colour for full-bleed surfaces, so a group using it lost
 * its card while the group above it kept one.
 *
 * The hairline is not decoration. Codex light puts the card at #ffffff on an
 * #f7f7f7 page, which is not an edge anyone can see; the border is what draws
 * the card in every theme, and the fill only deepens it where it can.
 *
 * `outline` is the same box with no fill and a dashed edge, for a section that
 * is instructions or a state the user cannot act on yet. A filled card reads as
 * a live object, which is the one thing those are not.
 */
export const SettingsList: Component<{ variant?: "card" | "outline"; children: JSX.Element }> = (props) => (
  <div
    class="px-4 rounded-lg border border-border-weak-base"
    classList={{
      "bg-surface-raised-base": props.variant !== "outline",
      "border-dashed": props.variant === "outline",
    }}
  >
    {props.children}
  </div>
)

export const SettingsRow: Component<{
  title: string | JSX.Element
  description: string | JSX.Element
  /** A mark the title cannot carry — a status light, an icon — kept out of the text column. */
  leading?: JSX.Element
  children: JSX.Element
}> = (props) => {
  // The control markup lives in `children` (Kobalte Switch/Select), so the
  // group wrapper carries the setting's name; the control's own role stays
  // exposed, now announced under that name.
  const titleId = createUniqueId()
  const descId = createUniqueId()
  // No wrap: the control dropping to its own line left one row twice the
  // height of its neighbours. The text column shrinks instead.
  return (
    <div class="flex items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
      {props.leading}
      <div class="flex flex-col gap-0.5 min-w-0 flex-1">
        <span id={titleId} class="text-14-medium text-text-strong">
          {props.title}
        </span>
        <span id={descId} class="text-12-regular text-text-weak">
          {props.description}
        </span>
      </div>
      <div class="flex-shrink-0" role="group" aria-labelledby={titleId} aria-describedby={descId}>
        {props.children}
      </div>
    </div>
  )
}

/**
 * What a section says when it has no rows.
 *
 * On the same surface the rows would have sat on, because a bare line of text
 * between two sections belongs to neither: the next harness's heading read as
 * part of the empty one above it.
 */
export const SettingsEmpty: Component<{ children: JSX.Element }> = (props) => (
  <div class="rounded-lg border border-border-weak-base bg-surface-raised-base px-4 py-6 text-center text-12-regular text-text-weak" data-component="settings-empty">
    {props.children}
  </div>
)

/**
 * What a section says about itself before its first control.
 *
 * `SettingsContent` draws this for the sections whose registry entry supplies
 * the words; a section that needs an action beside its name draws it itself,
 * which is the only reason this is a component rather than markup in there.
 *
 * An `h1`: the settings surface replaces the workbench column, so the open
 * section's name is the page's one level-one heading.
 */
export const SettingsSectionHeading: Component<{
  title: string
  description?: string
  action?: JSX.Element
}> = (props) => (
  <div class="flex items-start justify-between gap-4 pt-6 pb-6" data-component="settings-section-heading">
    <div class="flex min-w-0 flex-col gap-1">
      <h1 class="text-18-medium text-text-strong">{props.title}</h1>
      <Show when={props.description}>
        {(text) => <p class="text-12-regular text-text-weak">{text()}</p>}
      </Show>
    </div>
    <Show when={props.action}>
      <div class="flex shrink-0 items-center gap-2">{props.action}</div>
    </Show>
  </div>
)
