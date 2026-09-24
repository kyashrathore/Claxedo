import { createMemo, createSignal, Match, Show, Switch as Cases, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import type { SessionId } from "@/server"
import type { SessionListState, SessionRowView } from "@/session"
import { useSessionStores, useShellRoute } from "@/shell"
import { Button, Icon, Switch, TextInput } from "@/ui"
import { dictionary } from "../i18n"
import { visibleRows } from "../model"
import { SessionRows } from "./session-rows"

function ListLoading(): JSX.Element {
  const t = useTranslator(dictionary)
  const elapsed = useElapsed()
  return (
    <Show when={elapsed()}>
      <p class="rail-note" role="status">
        {t("rail.loading")}
      </p>
    </Show>
  )
}

function ListBody(props: {
  readonly state: SessionListState
  readonly rows: readonly SessionRowView[]
  readonly total: number
  readonly activeSessionId: SessionId | undefined
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <Cases>
      <Match when={props.state.kind === "failed" ? props.state : undefined}>
        {(failed) => (
          <p class="rail-note" role="alert">
            {t("rail.failed", { message: failed().message })}
          </p>
        )}
      </Match>
      <Match when={props.total === 0 && (props.state.kind === "subscribing" || props.state.kind === "fetching")}>
        <ListLoading />
      </Match>
      <Match when={props.rows.length === 0}>
        <p class="rail-note">{props.total === 0 ? t("rail.empty") : t("rail.noMatches")}</p>
      </Match>
      <Match when={props.rows.length > 0}>
        <SessionRows rows={props.rows} activeSessionId={props.activeSessionId} />
      </Match>
    </Cases>
  )
}

export function SessionList(): JSX.Element {
  const t = useTranslator(dictionary)
  const stores = useSessionStores()
  const routing = useShellRoute()
  const [query, setQuery] = createSignal("")
  const [showArchived, setShowArchived] = createSignal(false)
  const rows = createMemo(() => visibleRows(stores.list.rows(), query(), showArchived()))
  const activeSessionId = createMemo(() => {
    const route = routing.route()
    return route.kind === "session" ? route.sessionId : undefined
  })
  const loadMore = () => stores.list.loadMore().catch((error: unknown) => console.error("Loading more sessions failed", error))
  return (
    <section class="rail-sessions" aria-labelledby="rail-sessions-title">
      <h2 id="rail-sessions-title" class="rail-title">
        {t("rail.sessions")}
      </h2>
      <div class="rail-search">
        <TextInput
          type="search"
          aria-label={t("rail.search")}
          placeholder={t("rail.search")}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          leadingIcon={<Icon name="magnifying-glass" />}
          showClearButton={query().length > 0}
          clearLabel={t("rail.clearSearch")}
          onClearClick={() => setQuery("")}
        />
      </div>
      <div class="rail-filters">
        <Switch checked={showArchived()} onChange={setShowArchived}>
          {t("rail.showArchived")}
        </Switch>
      </div>
      <ListBody state={stores.list.state()} rows={rows()} total={stores.list.rows().length} activeSessionId={activeSessionId()} />
      <Show when={stores.list.hasMore()}>
        <Button variant="ghost" size="small" class="rail-load-more" onClick={() => void loadMore()}>
          {t("rail.loadMore")}
        </Button>
      </Show>
    </section>
  )
}
