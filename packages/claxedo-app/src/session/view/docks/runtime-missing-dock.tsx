import { Show } from "solid-js"
import type { SessionView } from "@/session"
import { draftPath, useShellRoute } from "@/shell"
import { Button } from "@/ui"
import { createDockAction } from "./dock-action"
import { useSessionScreenText } from "../text"

export function RuntimeMissingDock(props: { readonly view: SessionView }) {
  const t = useSessionScreenText()
  const routing = useShellRoute()
  const action = createDockAction<"retry">()
  return (
    <Show when={props.view.runtimeMissing()}>
      <section role="alert" class="mb-2 rounded-lg border border-border-weak-base bg-background-base p-3 text-text-base">
        <div class="text-12-regular">{t("sessionScreen.runtime.missing")}</div>
        <div class="flex flex-wrap gap-3">
          <Button variant="neutral" size="small" onClick={() => routing.navigate(draftPath(props.view.ref.placementId))}>
            {t("sessionScreen.runtime.newSession")}
          </Button>
          <Button variant="neutral" size="small" disabled={action.running()} onClick={() => void action.run("retry", props.view.reload)}>
            {t(action.running() ? "sessionScreen.action.loading" : "sessionScreen.action.retry")}
          </Button>
        </div>
      </section>
    </Show>
  )
}
