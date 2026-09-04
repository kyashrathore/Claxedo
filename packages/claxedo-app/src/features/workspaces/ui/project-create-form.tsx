import { createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { createProject, projectRequestMessage, type ProjectRecord, type ProjectSource } from "../data/project-api"

/**
 * Create a project: a name, then where its repository is.
 *
 * A project is a repository and a name; where it executes is a workspace,
 * chosen later in the composer's Environment and Workspace chips. So this
 * form never asks about execution. The repository is either a folder already
 * on this machine — offered only when the server has a filesystem, picked
 * through the server's directory browser — or a repository URL the server
 * clones under its data directory. A folder project is local by
 * construction; a repository project can run locally (its checkout) or in a
 * cloud sandbox.
 *
 * One component, two hosts: the composer's Project chip renders it in the
 * chip's panel; the empty canvas, which has no composer yet, renders it in a
 * dialog. Both hand it the same inputs.
 */
export function ProjectCreateForm(props: {
  baseUrl?: string
  /** Whether this server runs projects on its own filesystem (offers the folder source). */
  localExecution: boolean
  /**
   * Opens the server's directory browser; resolves to the chosen absolute
   * path. Receives the draft so a host whose picker replaces this form (the
   * dialog host) can bring the draft back with the choice.
   */
  pickFolder?: (draft: { name: string }) => Promise<string | undefined>
  /** A draft to resume — the dialog host re-creates the form after its picker. */
  initial?: { name?: string; folder?: string }
  onCreated: (project: ProjectRecord) => void
  onCancel?: () => void
}) {
  const [name, setName] = createSignal(props.initial?.name ?? "")
  const [folder, setFolder] = createSignal(props.initial?.folder ?? "")
  const [repoUrl, setRepoUrl] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  // Two sources, one at a time: a folder on this machine (the default where
  // the server has one) or a repository the server clones. The switch is a
  // text button in the panel's top-right corner, not a second section.
  const [source, setSource] = createSignal<"folder" | "repository">("folder")

  const offersFolder = () => props.localExecution && Boolean(props.pickFolder)
  const mode = () => (offersFolder() ? source() : "repository")
  const chosen = (): ProjectSource | undefined => {
    if (mode() === "folder") return folder() ? { kind: "directory", folder: folder() } : undefined
    return repoUrl().trim() ? { kind: "repository", repoUrl: repoUrl().trim() } : undefined
  }
  const suggestedName = () => {
    const from = mode() === "folder" ? folder() : repoUrl().trim()
    return (
      from
        .replace(/\/+$/, "")
        .split("/")
        .pop()
        ?.replace(/\.git$/, "") ?? ""
    )
  }
  const effectiveName = () => name().trim() || suggestedName()
  const canSubmit = () => !busy() && Boolean(effectiveName()) && Boolean(chosen())
  const switchSource = () => {
    setError("")
    setSource(source() === "folder" ? "repository" : "folder")
  }

  const submit = async (event: Event) => {
    event.preventDefault()
    const picked = chosen()
    if (!picked || !canSubmit()) return
    setBusy(true)
    setError("")
    try {
      const project = await createProject({ baseUrl: props.baseUrl, name: effectiveName(), source: picked })
      props.onCreated(project)
    } catch (cause) {
      setError(projectRequestMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const chooseFolder = async () => {
    const picked = await props.pickFolder?.({ name: name() })
    if (picked) setFolder(picked)
  }

  const label = "text-12-medium text-text-weak"
  const field =
    "h-8 w-full min-w-0 rounded-md border border-border-base bg-surface-inset-base px-2.5 text-13-regular text-text-strong placeholder:text-text-weak/60 focus:outline-none focus:border-border-interactive-base"

  return (
    <form
      onSubmit={(event) => void submit(event)}
      class="flex w-[340px] max-w-full flex-col gap-3"
      data-slot="project-create-form"
    >
      <Show when={offersFolder()}>
        <div class="-mb-2 flex justify-end">
          <button
            type="button"
            data-slot="project-create-source"
            class="text-11-medium text-text-weak underline-offset-2 hover:text-text-strong hover:underline focus-visible:underline focus-visible:outline-none"
            onClick={switchSource}
          >
            {mode() === "folder" ? "Clone a repository instead" : "Select a folder instead"}
          </button>
        </div>
      </Show>

      <label class="flex flex-col gap-1">
        <span class={label}>Name</span>
        <input
          type="text"
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
          placeholder={suggestedName() || "My project"}
          aria-label="Project name"
          class={field}
          autofocus
        />
      </label>

      <Show
        when={mode() === "folder"}
        fallback={
          <label class="flex flex-col gap-1">
            <span class={label}>Repository URL</span>
            <input
              type="text"
              value={repoUrl()}
              onInput={(event) => setRepoUrl(event.currentTarget.value)}
              placeholder="https://github.com/owner/repo"
              aria-label="Repository URL"
              spellcheck={false}
              class={field}
            />
            <span class="text-11-regular text-text-weak">
              Cloned on this server. Private GitHub repositories use the GitHub account connected in Settings.
            </span>
          </label>
        }
      >
        <div class="flex flex-col gap-1">
          <span class={label}>Project</span>
          <div class="flex items-center gap-2">
            <div
              class="flex h-8 min-w-0 flex-1 items-center rounded-md border border-border-base bg-surface-inset-base px-2.5"
              title={folder() || undefined}
            >
              <Show
                when={folder()}
                fallback={<span class="text-13-regular text-text-weak/60">No folder selected</span>}
              >
                <span class="truncate font-mono text-12-regular text-text-strong" data-slot="project-create-folder">
                  {folder()}
                </span>
              </Show>
            </div>
            <Button type="button" variant="secondary" size="small" class="shrink-0" onClick={() => void chooseFolder()}>
              Select project
            </Button>
          </div>
          <span class="text-11-regular text-text-weak">
            Runs on this machine or in a cloud sandbox; you choose when you start work.
          </span>
        </div>
      </Show>

      <Show when={error()}>
        <p class="text-12-regular text-icon-warning-base" role="alert">
          {error()}
        </p>
      </Show>

      <div class="flex justify-end gap-2 pt-1">
        <Show when={props.onCancel}>
          <Button type="button" variant="ghost" size="small" onClick={() => props.onCancel?.()}>
            Cancel
          </Button>
        </Show>
        <Button type="submit" variant="primary" size="small" disabled={!canSubmit()}>
          {busy() ? "Creating…" : "Create project"}
        </Button>
      </div>
    </form>
  )
}
