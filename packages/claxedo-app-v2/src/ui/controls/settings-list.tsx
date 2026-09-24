import { Show, createUniqueId, type Component, type JSX } from "solid-js"

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
  leading?: JSX.Element
  children: JSX.Element
}> = (props) => {
  const titleId = createUniqueId()
  const descId = createUniqueId()
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

export const SettingsEmpty: Component<{ children: JSX.Element }> = (props) => (
  <div class="rounded-lg border border-border-weak-base bg-surface-raised-base px-4 py-6 text-center text-12-regular text-text-weak" data-component="settings-empty">
    {props.children}
  </div>
)

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
