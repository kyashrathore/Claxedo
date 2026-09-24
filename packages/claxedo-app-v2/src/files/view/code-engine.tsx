import { createResource, Match, Switch, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { FailureNotice, failureMessage } from "@/lib/failure"
import { loadFileComponent } from "@/transcript"
import { dictionary } from "../i18n"
import { PlaceholderRows } from "./placeholder"

export type FileComponent = Awaited<ReturnType<typeof loadFileComponent>>

export function CodeEngine(props: {
  readonly label: string
  readonly children: (file: FileComponent) => JSX.Element
}): JSX.Element {
  const t = useTranslator(dictionary)
  const [engine, { refetch }] = createResource(loadFileComponent)
  return (
    <Switch fallback={<PlaceholderRows label={props.label} />}>
      <Match when={engine.state === "errored"}>
        <FailureNotice
          title={t("files.engineFailed")}
          message={failureMessage(engine.error)}
          retryLabel={t("files.retry")}
          onRetry={() => void refetch()}
        />
      </Match>
      <Match when={engine.state === "ready" && engine()}>{(file) => props.children(file())}</Match>
    </Switch>
  )
}
