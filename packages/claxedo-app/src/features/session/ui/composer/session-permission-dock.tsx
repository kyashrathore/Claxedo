import { For, Show, createSignal } from "solid-js"
import type { AgentPermission as PermissionRequest, AgentPermissionReply } from "@claxedo/agent-runtime-contract"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@/ui/session-kit"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useLanguage } from "@/platform/i18n/provider"
import { isRecord } from "@/lib/record"

type DictionaryKey = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

function permissionRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

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
  onDecide: (response: AgentPermissionReply) => void
  onStop?: () => Promise<unknown>
}) {
  const language = useLanguage()
  const [stopping, setStopping] = createSignal(false)
  const [stopError, setStopError] = createSignal<string>()
  const stop = async () => {
    if (!props.onStop || stopping()) return
    setStopping(true)
    setStopError(undefined)
    try {
      await props.onStop()
    } catch (error) {
      setStopError(error instanceof Error ? error.message : String(error))
    } finally {
      setStopping(false)
    }
  }
  const patterns = () => Array.isArray(props.request.patterns) ? props.request.patterns : []

  const command = () => typeof props.request.metadata.command === "string" ? props.request.metadata.command : undefined
  const agentTool = () => permissionRecord(props.request.metadata.acpToolCall)
  const reason = () => {
    const request = permissionRecord(props.request.metadata.acpRequestMeta)
    const permission = permissionRecord(request?.permission)
    if (permission?.version === 1 && typeof permission.description === "string") return permission.description
    return typeof props.request.metadata.reason === "string" ? props.request.metadata.reason : undefined
  }
  const directory = () => {
    const input = permissionRecord(agentTool()?.rawInput)
    return typeof input?.cwd === "string" ? input.cwd : undefined
  }
  const agentText = () => {
    const content = agentTool()?.content
    return Array.isArray(content) ? content.flatMap((item) => {
      const block = permissionRecord(item)
      const value = permissionRecord(block?.content)
      return block?.type === "content" && value?.type === "text" && typeof value.text === "string" ? [value.text] : []
    }) : []
  }
  const details = () => props.request.metadata.acpToolCall || props.request.metadata.acpRequestMeta
    ? JSON.stringify({ toolCall: props.request.metadata.acpToolCall, request: props.request.metadata.acpRequestMeta }, null, 2) : undefined

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
          <div>
            <Show when={props.onStop}>
              <Button variant="ghost" size="normal" onClick={() => void stop()} disabled={props.responding || stopping()}>
                {language.t("prompt.action.stop")}
              </Button>
            </Show>
          </div>
          <div data-slot="permission-footer-actions">
            <Show when={props.request.options !== undefined} fallback={
              <>
                <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding || stopping()}>
                  {language.t("ui.permission.deny")}
                </Button>
                <Button
                  variant="secondary"
                  size="normal"
                  onClick={() => props.onDecide("always")}
                  disabled={props.responding || stopping()}
                >
                  {language.t("ui.permission.allowAlways")}
                </Button>
                <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding || stopping()}>
                  {language.t("ui.permission.allowOnce")}
                </Button>
              </>
            }>
              <For each={props.request.options}>
                {(option) => <Button
                  variant="secondary"
                  size="normal"
                  title={option.description}
                  onClick={() => props.onDecide({ optionId: option.id })}
                  disabled={props.responding || stopping()}
                >{option.label}</Button>}
              </For>
            </Show>
          </div>
        </>
      }
    >
      <Show when={stopError()}>{(message) => <div role="alert">{message()}</div>}</Show>
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint" class="ui-permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={command()}>
        {(value) => <pre data-slot="permission-command" class="whitespace-pre-wrap break-all text-12-regular text-text-base">{value()}</pre>}
      </Show>
      <Show when={reason()}>
        {(value) => <div data-slot="permission-reason" class="text-12-regular text-text-base">{value()}</div>}
      </Show>
      <Show when={directory()}>
        {(value) => <div data-slot="permission-directory" class="text-12-regular text-text-base">Working directory: <code class="break-all">{value()}</code></div>}
      </Show>
      <For each={agentText()}>
        {(value) => <pre data-slot="permission-agent-text" class="whitespace-pre-wrap break-all text-12-regular text-text-base">{value}</pre>}
      </For>
      <Show when={details()}>
        {(value) => <details data-slot="permission-details"><summary>Details</summary><pre class="whitespace-pre-wrap break-all text-12-regular text-text-base">{value()}</pre></details>}
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
