import { useQuery } from "@tanstack/solid-query"
import { createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import type { Server } from "@/server"
import { DelayedLoading, Dialog, type useDialog } from "@/ui"
import { failureReason } from "../failure"
import { usePluginsText } from "../i18n"

type SourceTarget = { readonly id: string; readonly name: string }

function SourceFile(props: { readonly server: Server; readonly pluginId: string; readonly path: string }): JSX.Element {
  const t = usePluginsText()
  const file = useQuery(() => props.server.queries.livePlugins.sourceFile(props.pluginId, props.path))
  return (
    <Switch>
      <Match when={file.data}>
        {(data) => (
          <pre class="plugin-source-text" aria-label={data().path} tabindex="0">
            <code>{data().text}</code>
          </pre>
        )}
      </Match>
      <Match when={file.error}>{(error) => <p role="alert">{t("plugins.source.failed", { reason: failureReason(error()) })}</p>}</Match>
      <Match when={file.isPending}>
        <DelayedLoading>
          <p role="status">{t("plugins.source.loading")}</p>
        </DelayedLoading>
      </Match>
    </Switch>
  )
}

function SourceBrowser(props: { readonly server: Server; readonly target: SourceTarget }): JSX.Element {
  const t = usePluginsText()
  const listing = useQuery(() => props.server.queries.livePlugins.source(props.target.id))
  const [selected, setSelected] = createSignal<string>()
  return (
    <Switch>
      <Match when={listing.data}>
        {(data) => (
          <div class="plugin-source">
            <nav class="plugin-source-files" aria-label={t("plugins.source.files")}>
              <Show when={data().files.length > 0} fallback={<p>{t("plugins.source.empty")}</p>}>
                <For each={data().files}>
                  {(file) => (
                    <button type="button" class="plugin-source-file" aria-current={selected() === file.path ? "true" : undefined} onClick={() => setSelected(file.path)}>
                      {file.path}
                    </button>
                  )}
                </For>
              </Show>
              <Show when={data().truncated}>
                <p>{t("plugins.source.truncated", { count: data().files.length })}</p>
              </Show>
            </nav>
            <div class="plugin-source-view">
              <Show when={selected()} fallback={<p>{t("plugins.source.pick")}</p>} keyed>
                {(path) => <SourceFile server={props.server} pluginId={props.target.id} path={path} />}
              </Show>
            </div>
          </div>
        )}
      </Match>
      <Match when={listing.error}>{(error) => <p role="alert">{t("plugins.source.failed", { reason: failureReason(error()) })}</p>}</Match>
      <Match when={listing.isPending}>
        <DelayedLoading>
          <p role="status">{t("plugins.source.loading")}</p>
        </DelayedLoading>
      </Match>
    </Switch>
  )
}

function SourceDialog(props: { readonly server: Server; readonly target: SourceTarget }): JSX.Element {
  const t = usePluginsText()
  return (
    <Dialog title={t("plugins.source.title", { name: props.target.name })} size="x-large">
      <SourceBrowser server={props.server} target={props.target} />
    </Dialog>
  )
}

export function openPluginSource(dialog: ReturnType<typeof useDialog>, server: Server, target: SourceTarget): void {
  void dialog.show(() => <SourceDialog server={server} target={target} />)
}
