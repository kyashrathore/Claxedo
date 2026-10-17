import { createMemo, Show, untrack } from "solid-js"
import { surfaceSpecMessages, type SurfaceActionEvent, type SurfaceSpec } from "@claxedo/plugin-api/surface"
import { machine } from "@/lib/machine"
import { createSurface, SurfaceView } from "@/surface"
import { requestConfirm, useDialog } from "@/ui"
import { ClaxedoTool } from "./claxedo-tool"
import { surfaceReplySpec, surfaceReplySpecInput } from "./surface-reply-spec"
import { useData } from "./data"
import { useTranscriptI18n } from "./i18n"
import type { ToolProps } from "./message-part"
import { surfaceActionPrompt, surfaceReplyTransition, type SurfaceReplyEvent, type SurfaceReplyState } from "./surface-reply-action"

function SurfaceReplyBody(props: { readonly spec: SurfaceSpec; readonly surfaceId: string }) {
  const data = useData()
  const dialog = useDialog()
  const i18n = useTranscriptI18n()
  const spec = untrack(() => props.spec)
  const surface = createSurface(untrack(() => props.surfaceId))
  for (const message of surfaceSpecMessages(surface.surfaceId, spec)) surface.apply(message)
  const reply = machine<SurfaceReplyState, SurfaceReplyEvent>({ kind: "idle" }, surfaceReplyTransition)
  const act = async (action: SurfaceActionEvent) => {
    const send = data.sendPrompt
    if (!send || reply.state().kind === "sending") return
    const confirmed = await requestConfirm(dialog, {
      title: i18n.t("transcript.surfaceReply.confirm.title", { action: action.name }),
      body: i18n.t("transcript.surfaceReply.confirm.body", { title: spec.title }),
      confirmLabel: i18n.t("transcript.surfaceReply.confirm.send"),
      cancelLabel: i18n.t("transcript.surfaceReply.confirm.cancel"),
    })
    if (!confirmed) return
    reply.send({ type: "started" })
    const answer = await send(surfaceActionPrompt(spec.title, action))
    reply.send(answer.ok ? { type: "sent" } : { type: "failed", message: answer.message })
  }
  const failure = () => {
    const state = reply.state()
    return state.kind === "failed" ? state.message : undefined
  }
  return (
    <div data-component="surface-reply">
      <span data-slot="surface-reply-title">{spec.title}</span>
      <SurfaceView
        surface={surface}
        source={{ kind: "agent", label: data.harnessLabel ?? i18n.t("transcript.surfaceReply.agent") }}
        onAction={data.sendPrompt ? (action) => void act(action) : undefined}
        actionsDisabled={reply.state().kind === "sending"}
      />
      <Show when={failure()}>{(message) => <span data-slot="surface-reply-failure" role="alert">{message()}</span>}</Show>
    </div>
  )
}

export function SurfaceReply(props: ToolProps) {
  const specText = createMemo(() => JSON.stringify(surfaceReplySpecInput(props.input)))
  const spec = createMemo(() => surfaceReplySpec(JSON.parse(specText())))
  return (
    <Show when={spec()} keyed fallback={<ClaxedoTool {...props} />}>
      {(valid) => <SurfaceReplyBody spec={valid} surfaceId={props.toolCallId ?? "ui_show"} />}
    </Show>
  )
}
