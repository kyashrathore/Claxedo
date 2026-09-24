import { For, Show } from "solid-js"
import type { AgentPermission, AgentPermissionReply } from "@claxedo/agent-runtime-contract"
import type { AgentRequestReply } from "@/server"
import type { RequestState } from "@/session"
import { DockPrompt } from "@/transcript"
import { Button } from "@opencode-ai/ui/button"
import { ClaxedoIcon as Icon } from "@/ui"
import { isRecord } from "@/lib/record"
import type { SessionScreenTextKey } from "../i18n"
import { useSessionScreenText } from "../text"
import { createDockAction } from "./dock-action"
import { replyError } from "./model"

const TOOL_KEYS: Readonly<Record<string, SessionScreenTextKey>> = {
  read: "sessionScreen.permission.tool.read",
  edit: "sessionScreen.permission.tool.edit",
  glob: "sessionScreen.permission.tool.glob",
  grep: "sessionScreen.permission.tool.grep",
  list: "sessionScreen.permission.tool.list",
  bash: "sessionScreen.permission.tool.bash",
  task: "sessionScreen.permission.tool.task",
  skill: "sessionScreen.permission.tool.skill",
  lsp: "sessionScreen.permission.tool.lsp",
  todowrite: "sessionScreen.permission.tool.todowrite",
  webfetch: "sessionScreen.permission.tool.webfetch",
  websearch: "sessionScreen.permission.tool.websearch",
  external_directory: "sessionScreen.permission.tool.external_directory",
  doom_loop: "sessionScreen.permission.tool.doom_loop",
}

function record(value: unknown) {
  return isRecord(value) ? value : undefined
}

function agentText(tool: Record<string, unknown> | undefined) {
  const content = Array.isArray(tool?.content) ? tool.content : []
  return content.flatMap((item) => {
    const block = record(item)
    const value = record(block?.content)
    return block?.type === "content" && value?.type === "text" && typeof value.text === "string" ? [value.text] : []
  })
}

function permissionFacts(request: AgentPermission) {
  const tool = record(request.metadata.acpToolCall)
  const meta = record(request.metadata.acpRequestMeta)
  const permission = record(meta?.permission)
  const input = record(tool?.rawInput)
  const description = permission?.version === 1 && typeof permission.description === "string" ? permission.description : undefined
  return {
    command: typeof request.metadata.command === "string" ? request.metadata.command : undefined,
    reason: description ?? (typeof request.metadata.reason === "string" ? request.metadata.reason : undefined),
    directory: typeof input?.cwd === "string" ? input.cwd : undefined,
    agentText: agentText(tool),
    details: tool || meta ? JSON.stringify({ toolCall: tool, request: meta }, null, 2) : undefined,
  }
}

type Facts = ReturnType<typeof permissionFacts>

function PermissionFacts(props: { facts: Facts; patterns: readonly string[] }) {
  const t = useSessionScreenText()
  return (
    <>
      <Show when={props.facts.command}>
        {(value) => <pre data-slot="permission-command" class="whitespace-pre-wrap break-all text-12-regular text-text-base">{value()}</pre>}
      </Show>
      <Show when={props.facts.reason}>
        {(value) => <div data-slot="permission-reason" class="text-12-regular text-text-base">{value()}</div>}
      </Show>
      <Show when={props.facts.directory}>
        {(value) => (
          <div data-slot="permission-directory" class="text-12-regular text-text-base">
            {t("sessionScreen.permission.workingDirectory")}: <code class="break-all">{value()}</code>
          </div>
        )}
      </Show>
      <For each={props.facts.agentText}>
        {(value) => <pre data-slot="permission-agent-text" class="whitespace-pre-wrap break-all text-12-regular text-text-base">{value}</pre>}
      </For>
      <Show when={props.facts.details}>
        {(value) => (
          <details data-slot="permission-details">
            <summary>{t("sessionScreen.permission.details")}</summary>
            <pre class="whitespace-pre-wrap break-all text-12-regular text-text-base">{value()}</pre>
          </details>
        )}
      </Show>
      <Show when={props.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.patterns}>{(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}</For>
          </div>
        </div>
      </Show>
    </>
  )
}

function PermissionFooter(props: {
  request: AgentPermission
  busy: boolean
  onStop?: () => void
  onDecide: (reply: AgentPermissionReply) => void
}) {
  const t = useSessionScreenText()
  return (
    <>
      <div>
        <Show when={props.onStop}>
          {(stop) => (
            <Button variant="ghost" size="normal" disabled={props.busy} onClick={() => stop()()}>
              {t("sessionScreen.action.stop")}
            </Button>
          )}
        </Show>
      </div>
      <div data-slot="permission-footer-actions">
        <Show
          when={props.request.options}
          fallback={
            <>
              <Button variant="ghost" size="normal" disabled={props.busy} onClick={() => props.onDecide("reject")}>
                {t("sessionScreen.permission.deny")}
              </Button>
              <Button variant="secondary" size="normal" disabled={props.busy} onClick={() => props.onDecide("always")}>
                {t("sessionScreen.permission.allowAlways")}
              </Button>
              <Button variant="primary" size="normal" disabled={props.busy} onClick={() => props.onDecide("once")}>
                {t("sessionScreen.permission.allowOnce")}
              </Button>
            </>
          }
        >
          {(options) => (
            <For each={options()}>
              {(option) => (
                <Button variant="secondary" size="normal" title={option.description} disabled={props.busy} onClick={() => props.onDecide({ optionId: option.id })}>
                  {option.label}
                </Button>
              )}
            </For>
          )}
        </Show>
      </div>
    </>
  )
}

export function PermissionDock(props: {
  request: AgentPermission
  replyState: RequestState
  onReply: (reply: AgentRequestReply) => void
  onStop?: () => Promise<void>
}) {
  const t = useSessionScreenText()
  const stop = createDockAction<"stop">()
  const facts = () => permissionFacts(props.request)
  const busy = () => props.replyState.kind === "answering" || stop.running()
  const hint = () => {
    const key = TOOL_KEYS[props.request.permission]
    return key ? t(key) : ""
  }
  const runStop = () => {
    const work = props.onStop
    if (work) void stop.run("stop", work)
  }
  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title" class="ui-permission-header-title">{t("sessionScreen.permission.title")}</div>
        </div>
      }
      footer={
        <PermissionFooter
          request={props.request}
          busy={busy()}
          onStop={props.onStop ? runStop : undefined}
          onDecide={(value) => {
            if (!busy()) props.onReply({ kind: "permission", reply: value })
          }}
        />
      }
    >
      <Show when={replyError(props.replyState) ?? stop.error()}>
        {(error) => <div role="alert" data-slot="permission-error" data-error-class={error().class}>{error().message}</div>}
      </Show>
      <Show when={hint()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint" class="ui-permission-hint">{hint()}</div>
        </div>
      </Show>
      <PermissionFacts facts={facts()} patterns={props.request.patterns} />
    </DockPrompt>
  )
}
