import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { GitStatus } from "@/server"
import { SemanticIcon, Button, Spinner } from "@/ui"
import { dictionary } from "../i18n"

function ActionButton(props: {
  readonly testId: string
  readonly label: string
  readonly pending: boolean
  readonly onClick: () => void
}): JSX.Element {
  return (
    <Button data-testid={props.testId} variant="ghost" size="small" class="gap-1.5" onClick={() => props.onClick()}>
      <Show when={props.pending} fallback={<SemanticIcon concept="push" size="small" />}>
        <Spinner class="size-3" />
      </Show>
      <span>{props.label}</span>
    </Button>
  )
}

export function PushRow(props: {
  readonly status: GitStatus
  readonly pending: boolean
  readonly onPush: (setUpstream: boolean) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border-weak-base px-2">
      <Show
        when={props.status.upstream !== undefined}
        fallback={
          <ActionButton
            testId="source-control-publish"
            label={t("review.sourceControl.publish")}
            pending={props.pending}
            onClick={() => props.onPush(true)}
          />
        }
      >
        <Show
          when={props.status.ahead > 0}
          fallback={
            <span data-testid="source-control-up-to-date" class="px-2 text-12-regular text-text-weaker">
              {t("review.sourceControl.upToDate")}
            </span>
          }
        >
          <ActionButton
            testId="source-control-push"
            label={`${t("review.sourceControl.push")} ${props.status.ahead}`}
            pending={props.pending}
            onClick={() => props.onPush(false)}
          />
        </Show>
      </Show>
      <span class="flex-1" />
    </div>
  )
}
