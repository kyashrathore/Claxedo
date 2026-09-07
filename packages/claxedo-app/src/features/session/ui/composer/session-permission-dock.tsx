import { For, Show } from "solid-js"
import type { AgentPermission as PermissionRequest } from "@claxedo/agent-runtime-contract"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@/ui/session-kit"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useLanguage } from "@/platform/i18n/provider"

type DictionaryKey = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

/**
 * Listed per permission rather than assembled from the id, so every key is a
 * literal the dictionary audit can find a reader for. Permissions outside this
 * table (MCP tools, ACP kinds, subagent ids) show no hint.
 */
const TOOL_DESCRIPTION_KEYS: Partial<Record<string, DictionaryKey>> = {
  read: "settings.permissions.tool.read.description",
  edit: "settings.permissions.tool.edit.description",
  glob: "settings.permissions.tool.glob.description",
  grep: "settings.permissions.tool.grep.description",
  list: "settings.permissions.tool.list.description",
  bash: "settings.permissions.tool.bash.description",
  task: "settings.permissions.tool.task.description",
  skill: "settings.permissions.tool.skill.description",
  lsp: "settings.permissions.tool.lsp.description",
  todowrite: "settings.permissions.tool.todowrite.description",
  webfetch: "settings.permissions.tool.webfetch.description",
  websearch: "settings.permissions.tool.websearch.description",
  external_directory: "settings.permissions.tool.external_directory.description",
  doom_loop: "settings.permissions.tool.doom_loop.description",
}

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const patterns = () => Array.isArray(props.request.patterns) ? props.request.patterns : []

  const toolDescription = () => {
    const key = TOOL_DESCRIPTION_KEYS[props.request.permission]
    return key ? language.t(key) : ""
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title" class="ui-permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint" class="ui-permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={patterns().length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={patterns()}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
