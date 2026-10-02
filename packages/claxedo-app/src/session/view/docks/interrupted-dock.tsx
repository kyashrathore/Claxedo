import { Show } from "solid-js"
import type { SessionView } from "@/session"
import { Button } from "@/ui"
import { createDockAction } from "./dock-action"
import { useSessionScreenText } from "../text"

export function InterruptedDock(props: { readonly view: SessionView }) {
  const t = useSessionScreenText()
  const action = createDockAction<"resume">()
  const resume = () => action.run("resume", () => props.view.send({
    clientRequestId: crypto.randomUUID(),
    text: t("sessionScreen.interrupted.prompt"),
    attachments: [],
  }))
  return (
    <Show when={props.view.status().kind === "interrupted"}>
      <section aria-label={t("sessionScreen.interrupted.title")} class="mb-2 rounded-lg border border-border-weak-base bg-background-base p-3 text-text-base">
        <div class="text-12-medium">{t("sessionScreen.interrupted.title")}</div>
        <div class="text-12-regular">{t("sessionScreen.interrupted.description")}</div>
        <Show when={action.error()}>{(error) => <div role="alert">{error().message}</div>}</Show>
        <Button variant="neutral" size="small" disabled={action.running()} onClick={() => void resume()}>
          {t(action.running() ? "sessionScreen.action.loading" : "sessionScreen.interrupted.resume")}
        </Button>
      </section>
    </Show>
  )
}
