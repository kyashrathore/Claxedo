import { Match, Show, Switch, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { Button } from "@/ui"
import { dictionary } from "../i18n"
import type { BrowserTab } from "../tab"

function Overlay(props: { readonly title: string; readonly hint?: string; readonly children?: JSX.Element }): JSX.Element {
  return (
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background-base p-6 text-center">
      <div class="text-sm font-medium text-text-base">{props.title}</div>
      <Show when={props.hint}>{(hint) => <div class="max-w-72 break-words text-sm text-text-muted">{hint()}</div>}</Show>
      {props.children}
    </div>
  )
}

function LoadingBar(): JSX.Element {
  const t = useTranslator(dictionary)
  const elapsed = useElapsed()
  return (
    <Show when={elapsed()}>
      <div role="status" aria-label={t("browser.loading")} class="pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-pulse bg-icon-accent" />
    </Show>
  )
}

export function PageState(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
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
            <Button variant="outline" size="small" onClick={() => void props.tab.navigate(current().url)}>
              {t("browser.retry")}
            </Button>
          </Overlay>
        )}
      </Match>
      <Match when={state().kind === "loading"}>
        <LoadingBar />
      </Match>
    </Switch>
  )
}
