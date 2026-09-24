import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginCandidate, PluginMcpServer, PluginToolGroup } from "@/server"
import { Switch } from "@/ui"
import { dictionary, type MarketplaceKey } from "../i18n"
import { isBuiltIn, toolGroups } from "../model"
import { ROW } from "./chrome"

function ServerDot(props: { readonly required: boolean }): JSX.Element {
  return (
    <span
      class="size-1.5 shrink-0 rounded-full"
      classList={{ "bg-surface-warning-strong": props.required, "bg-surface-raised-stronger": !props.required }}
    />
  )
}

function ToolGroupRows(props: {
  readonly groups: readonly PluginToolGroup[]
  readonly pending: boolean
  readonly onToolGroup: (group: PluginToolGroup, enabled: boolean) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <>
      <For each={props.groups}>
        {(group) => (
          <div class={`${ROW} mb-1.5 flex items-start gap-2`} data-agent-plugin-tool-group={group.id}>
            <div class="min-w-0 flex-1">
              <div class="truncate text-12-medium text-text-strong">{group.id}</div>
              <div class="break-words text-12-mono text-text-weaker">{group.tools.join(", ")}</div>
            </div>
            <Switch
              checked={group.enabled}
              disabled={props.pending}
              hideLabel
              onChange={(enabled: boolean) => props.onToolGroup(group, enabled)}
            >
              {group.id}
            </Switch>
          </div>
        )}
      </For>
      <p class="text-11-regular text-text-weaker">{t("marketplace.mcp.appliesNext")}</p>
    </>
  )
}

const AUTH_KEYS: Record<"public" | "local" | "harness", MarketplaceKey> = {
  public: "marketplace.mcp.public",
  local: "marketplace.mcp.local",
  harness: "marketplace.mcp.harness",
}

function ServerRow(props: { readonly server: PluginMcpServer; readonly retained: boolean }): JSX.Element {
  const t = useTranslator(dictionary)
  const auth = () => props.server.authentication
  const oauth = () => auth().state === "oauth"
  const message = () => {
    const current = auth()
    if (current.state === "unavailable")
      return t("marketplace.mcp.unavailable", { reason: current.reason.replaceAll("_", " ") })
    if (current.state === "oauth") return undefined
    return t(AUTH_KEYS[current.state])
  }
  const oauthLine = () =>
    t(props.retained ? "marketplace.mcp.connectionRequired" : "marketplace.mcp.enableFirst", {
      type: props.server.type,
    })
  return (
    <div class={`${ROW} mb-1.5 flex items-center gap-2`}>
      <ServerDot required={oauth()} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-12-medium text-text-strong">{props.server.name}</div>
        <div class="text-11-regular text-text-weaker">{oauth() ? oauthLine() : props.server.type}</div>
      </div>
      <Show when={message()}>{(text) => <span class="shrink-0 text-11-regular text-text-weak">{text()}</span>}</Show>
    </div>
  )
}

export function PluginMcpServers(props: {
  readonly plugin: PluginCandidate
  readonly pending: boolean
  readonly onToolGroup: (group: PluginToolGroup, enabled: boolean) => void
}): JSX.Element {
  return (
    <Show
      when={isBuiltIn(props.plugin)}
      fallback={
        <For each={props.plugin.mcpServers}>
          {(server) => <ServerRow server={server} retained={Boolean(props.plugin.retainedDigest)} />}
        </For>
      }
    >
      <ToolGroupRows groups={toolGroups(props.plugin)} pending={props.pending} onToolGroup={props.onToolGroup} />
    </Show>
  )
}
