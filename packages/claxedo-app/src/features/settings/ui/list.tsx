import { createUniqueId, type Component, type JSX } from "solid-js"

export const SettingsList: Component<{ children: JSX.Element }> = (props) => {
  return <div class="bg-surface-base px-4 rounded-lg">{props.children}</div>
}

export const SettingsRow: Component<{
  title: string
  description: string | JSX.Element
  children: JSX.Element
}> = (props) => {
  // The control markup lives in `children` (Kobalte Switch/Select), so the
  // group wrapper carries the setting's name; the control's own role stays
  // exposed, now announced under that name.
  const titleId = createUniqueId()
  const descId = createUniqueId()
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-0.5 min-w-0">
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
