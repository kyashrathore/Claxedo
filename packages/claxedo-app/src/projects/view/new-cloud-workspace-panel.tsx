import { createSignal, type JSX } from "solid-js"
import { Button, TextField } from "@/ui"
import { newCloudName, type WhereChoice } from "../draft-where"
import { useProjectsText } from "../i18n"

export function NewCloudWorkspacePanel(props: { readonly close: () => void; readonly back: () => void; readonly onName: (choice: WhereChoice) => void }): JSX.Element {
  const t = useProjectsText()
  const [name, setName] = createSignal("")
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const choice = newCloudName(name())
    if (!choice) return
    props.close()
    props.onName(choice)
  }
  return (
    <form class="flex w-[300px] max-w-full flex-col gap-3" onSubmit={submit}>
      <TextField label={t("projects.chip.newCloud.name")} description={t("projects.chip.newCloud.hint")} value={name()} onChange={setName} required autofocus spellcheck={false} />
      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="small" onClick={() => props.back()}>
          {t("projects.cancel")}
        </Button>
        <Button type="submit" variant="contrast" size="small" disabled={newCloudName(name()) === undefined}>
          {t("projects.chip.newCloud")}
        </Button>
      </div>
    </form>
  )
}
