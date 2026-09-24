import { createSignal, For, Match, Switch, type Component } from "solid-js"
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Field, Icon, ScrollView, TextInput, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { useFolderListing, type FolderListing } from "../store"

function underHome(path: string, home: string): string {
  if (path === home) return "~"
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const FolderRows: Component<{ listing: FolderListing; onOpen: (path: string) => void }> = (props) => {
  const t = useProjectsText()
  return (
    <ScrollView class="projects-folders" label={t("projects.picker.folders")}>
      <ul class="m-0 flex list-none flex-col p-0">
        <For each={props.listing.folders} fallback={<li class="projects-hint px-2 py-3">{t("projects.picker.empty")}</li>}>
          {(folder) => (
            <li>
              <button type="button" class="projects-folder" onClick={() => props.onOpen(folder.path)}>
                <Icon name="folder" />
                <span class="truncate">{folder.name}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </ScrollView>
  )
}

export const FolderBrowserDialog: Component<{ onChoose: (path: string) => void }> = (props) => {
  const t = useProjectsText()
  const dialog = useDialog()
  const [path, setPath] = createSignal<string>()
  const [editing, setEditing] = createSignal<string>()
  const listing = useFolderListing(path)
  const current = () => {
    const state = listing()
    return state.kind === "ready" ? state.data : undefined
  }
  const shownPath = () => {
    const folder = current()
    return folder ? underHome(folder.path, folder.home) : ""
  }
  const failure = () => {
    const state = listing()
    return state.kind === "failed" ? state.error.message : undefined
  }
  const open = (next: string) => {
    setEditing(undefined)
    setPath(next)
  }
  const go = (event: SubmitEvent) => {
    event.preventDefault()
    const typed = editing()?.trim()
    if (typed) open(typed)
  }
  const choose = () => {
    const folder = current()
    if (!folder) return
    props.onChoose(folder.path)
    dialog.close()
  }

  return (
    <Dialog fit>
      <DialogHeader closeLabel={t("projects.close")}>
        <DialogTitle>{t("projects.picker.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-3 px-4">
        <form class="flex items-end gap-2" onSubmit={go}>
          <Field class="min-w-0 flex-1">
            <Field.Label>{t("projects.picker.path")}</Field.Label>
            <Field.Control>
              <TextInput
                class="w-full font-mono"
                value={editing() ?? shownPath()}
                placeholder={t("projects.add.folder.placeholder")}
                spellcheck={false}
                onInput={(event) => setEditing(event.currentTarget.value)}
              />
            </Field.Control>
          </Field>
          <Button type="submit" variant="outline">
            {t("projects.picker.go")}
          </Button>
        </form>
        <Button class="self-start" variant="ghost" disabled={!current()?.parent} onClick={() => open(current()?.parent ?? "")}>
          {t("projects.picker.up")}
        </Button>
        <Switch>
          <Match when={failure()}>
            {(message) => (
              <p class="projects-alert m-0" role="alert">
                {t("projects.picker.failed")}: {message()}
              </p>
            )}
          </Match>
          <Match when={current()}>{(folder) => <FolderRows listing={folder()} onOpen={open} />}</Match>
          <Match when={listing().kind === "loading"}>
            <p class="projects-hint projects-placeholder m-0">{t("projects.loading")}</p>
          </Match>
        </Switch>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => dialog.close()}>
          {t("projects.cancel")}
        </Button>
        <Button type="button" variant="contrast" disabled={!current()} onClick={choose}>
          {t("projects.picker.choose")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
