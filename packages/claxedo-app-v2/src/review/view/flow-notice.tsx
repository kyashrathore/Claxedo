import { Show, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import type { AppError } from "@/server"
import { dictionary } from "../i18n"
import { gitErrorCopy, type CommitFlow, type PushFlow } from "../model"

export function useErrorText(): (error: AppError) => string {
  const t = useTranslator(dictionary)
  const errorCopy = useErrorCopy()
  return (error) => {
    const git = gitErrorCopy(error)
    return git ? t(git.key, git.params) : errorCopy(error).message
  }
}

export function FailureText(props: { readonly error: AppError }): JSX.Element {
  const errorText = useErrorText()
  return (
    <span role="alert" class="break-words text-danger-fg">
      {errorText(props.error)}
    </span>
  )
}

export function FlowNotice(props: { readonly commit: CommitFlow; readonly push: PushFlow }): JSX.Element {
  const t = useTranslator(dictionary)
  const committed = () => (props.commit.kind === "done" ? props.commit.result.hash.slice(0, 7) : undefined)
  const pushed = () => (props.push.kind === "done" ? props.push.result : undefined)
  const commitError = () => (props.commit.kind === "failed" ? props.commit.error : undefined)
  const pushError = () => (props.push.kind === "failed" ? props.push.error : undefined)
  return (
    <div role="status" class="flex flex-col gap-1 text-xs text-text-muted">
      <Show when={committed()}>{(hash) => <span>{t("review.commit.done", { hash: hash() })}</span>}</Show>
      <Show when={commitError()}>{(error) => <FailureText error={error()} />}</Show>
      <Show when={pushed()}>
        {(result) => <span>{t("review.push.done", { remote: result().remote, branch: result().branch })}</span>}
      </Show>
      <Show when={pushError()}>{(error) => <FailureText error={error()} />}</Show>
    </div>
  )
}
