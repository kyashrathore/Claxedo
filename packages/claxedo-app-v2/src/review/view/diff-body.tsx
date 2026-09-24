import { Match, Switch, type JSX } from "solid-js"
import { PlaceholderRows } from "@/files"
import { useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import { Button } from "@/ui"
import { MAX_DIFF_CHANGED_LINES, type DiffBody as DiffBodyState } from "../diff-content"
import { dictionary } from "../i18n"
import { useErrorText } from "./flow-notice"

export function DiffBody(props: { readonly body: DiffBodyState; readonly onForce: () => void }): JSX.Element {
  const t = useTranslator(dictionary)
  const errorText = useErrorText()
  return (
    <Switch>
      <Match when={props.body.kind === "media"}>
        <div role="status" class="px-3 py-4 text-sm text-text-muted">
          {t("review.diff.media")}
        </div>
      </Match>
      <Match when={props.body.kind === "large" && props.body}>
        {(large) => (
          <div data-slot="session-review-large-diff" class="flex flex-col items-start gap-2 px-3 py-4">
            <div class="text-sm font-medium text-text-base">{t("review.largeDiff.title")}</div>
            <div class="text-xs text-text-muted">
              {t("review.largeDiff.meta", { limit: MAX_DIFF_CHANGED_LINES, current: large().changedLines })}
            </div>
            <Button variant="outline" size="small" onClick={() => props.onForce()}>
              {t("review.largeDiff.renderAnyway")}
            </Button>
          </div>
        )}
      </Match>
      <Match when={props.body.kind === "failed" && props.body}>
        {(failed) => (
          <FailureNotice title={t("review.diff.failed")} message={errorText(failed().error)} retryLabel={t("review.retry")} onRetry={failed().retry} />
        )}
      </Match>
      <Match when={props.body.kind === "loading"}>
        <PlaceholderRows label={t("review.diff.loading")} rows={3} />
      </Match>
    </Switch>
  )
}
