import { createUniqueId, Show, type JSX } from "solid-js"
import "./settings.css"

export function SettingsIntro(props: { readonly description?: string; readonly action?: JSX.Element }) {
  return (
    <div class="settings-intro">
      <Show when={props.description}>{(text) => <p class="settings-description">{text()}</p>}</Show>
      <Show when={props.action}>{(action) => <div class="settings-intro-action">{action()}</div>}</Show>
    </div>
  )
}

export function SettingsGroup(props: { readonly title?: string; readonly description?: string; readonly action?: JSX.Element; readonly children: JSX.Element }) {
  const titleId = createUniqueId()
  return (
    <section class="settings-group" role={props.title ? "group" : undefined} aria-labelledby={props.title ? titleId : undefined}>
      <Show when={props.title || props.action}>
        <div class="settings-group-head">
          <div>
            <Show when={props.title}>{(title) => <h2 id={titleId} class="settings-group-title">{title()}</h2>}</Show>
            <Show when={props.description}>{(text) => <p class="settings-description">{text()}</p>}</Show>
          </div>
          {props.action}
        </div>
      </Show>
      {props.children}
    </section>
  )
}

export function SettingsList(props: { readonly variant?: "card" | "outline"; readonly children: JSX.Element }) {
  return (
    <div class="settings-list" data-variant={props.variant ?? "card"}>
      {props.children}
    </div>
  )
}

export function SettingsRow(props: {
  readonly title: JSX.Element
  readonly description?: JSX.Element
  readonly leading?: JSX.Element
  readonly children?: JSX.Element
}) {
  const titleId = createUniqueId()
  const descriptionId = createUniqueId()
  return (
    <div class="settings-row">
      {props.leading}
      <div class="settings-row-text">
        <span id={titleId} class="settings-row-title">{props.title}</span>
        <Show when={props.description}>
          <span id={descriptionId} class="settings-row-description">{props.description}</span>
        </Show>
      </div>
      <Show when={props.children}>
        <div class="settings-row-control" role="group" aria-labelledby={titleId} aria-describedby={props.description ? descriptionId : undefined}>
          {props.children}
        </div>
      </Show>
    </div>
  )
}

export function SettingsEmpty(props: { readonly children: JSX.Element }) {
  return (
    <div class="settings-empty">
      {props.children}
    </div>
  )
}

export function SettingsNote(props: { readonly tone?: "muted" | "danger"; readonly children: JSX.Element }) {
  return (
    <p class="settings-note" data-tone={props.tone ?? "muted"} role={props.tone === "danger" ? "alert" : undefined}>
      {props.children}
    </p>
  )
}
