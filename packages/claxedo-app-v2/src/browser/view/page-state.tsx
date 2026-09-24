import { Match, Show, Switch, type JSX } from "solid-js"
import { t } from "../i18n"
import type { BrowserTab } from "../tab"
import { toolbarButtonClass } from "./toolbar"

function Overlay(props: { readonly title: string; readonly hint?: string; readonly children?: JSX.Element }) {
  return (
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background-base p-6 text-center">
      <div class="text-12-medium text-text-base">{props.title}</div>
      <Show when={props.hint}>{(hint) => <div class="max-w-72 text-12-regular text-text-weak">{hint()}</div>}</Show>
      {props.children}
    </div>
  )
}

export function PageState(props: { readonly tab: BrowserTab }) {
  const state = () => props.tab.state()
  const failed = () => {
    const current = state()
    return current.kind === "failed" ? current : undefined
  }
  return (
    <Switch>
      <Match when={!state().url}>
        <Overlay title={t("browser.empty.title")} hint={props.tab.bridge ? t("browser.empty.hint") : t("browser.web.hint")} />
      </Match>
      <Match when={failed()}>
        {(current) => (
          <Overlay title={t("browser.failed.title")} hint={current().reason}>
            <button type="button" class={toolbarButtonClass} onClick={() => void props.tab.navigate(current().url)}>
              {t("browser.retry")}
            </button>
          </Overlay>
        )}
      </Match>
      <Match when={state().kind === "loading"}>
        <div
          role="status"
          aria-label={t("browser.loading")}
          class="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-border-strong-base opacity-0 [animation:browser-fade_0s_linear_150ms_forwards]"
        />
        <style>{"@keyframes browser-fade { to { opacity: 1 } }"}</style>
      </Match>
    </Switch>
  )
}
