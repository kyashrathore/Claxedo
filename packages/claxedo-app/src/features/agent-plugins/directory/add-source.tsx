import { createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DirectorySourceError, type DirectorySourceDiagnostic, type DirectorySourceRegistration } from "./data"

const FIELD = "h-7 w-full rounded-md border border-border-weak-base bg-surface-base px-2 py-0 text-13-regular text-text-base"

/**
 * The inline "add a GitHub source" form.
 *
 * The server refuses a repository that serves no valid plugin and answers with
 * the probe's diagnostics; those are the only thing that tells the user which
 * file failed to validate, so they are rendered here rather than flattened into
 * a toast.
 */
export function AddSourceForm(props: {
  organizationAllowed: boolean
  organizationName?: string
  onAdd: (registration: DirectorySourceRegistration) => Promise<void>
  onCancel: () => void
}) {
  const [slug, setSlug] = createSignal("")
  const [ref, setRef] = createSignal("")
  const [organization, setOrganization] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [diagnostics, setDiagnostics] = createSignal<DirectorySourceDiagnostic[]>([])
  const [busy, setBusy] = createSignal(false)

  const submit = async (event: Event) => {
    event.preventDefault()
    setError(undefined)
    setDiagnostics([])
    const [owner, repository, ...rest] = slug().trim().split("/")
    if (!owner || !repository || rest.length > 0) {
      setError("Enter a GitHub repository as owner/repository")
      return
    }
    setBusy(true)
    try {
      const trimmedRef = ref().trim()
      await props.onAdd({
        owner,
        repository,
        ...(trimmedRef ? { ref: trimmedRef } : {}),
        ...(organization() ? { authority: "organization" as const } : {}),
      })
      setSlug("")
      setRef("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      if (cause instanceof DirectorySourceError) setDiagnostics(cause.diagnostics)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      data-component="agent-plugin-add-source"
      aria-label="Add source"
      class="grid gap-2 rounded-lg border border-border-weak-base bg-surface-inset-base p-3"
      onSubmit={submit}
    >
      <p class="text-12-regular text-text-weak">
        A public GitHub repository whose top-level folders are plugins: each holds a <code class="text-12-mono">plugin.json</code>
        (Agent Plugins schema 1.0.0), optional <code class="text-12-mono">skills/&lt;name&gt;/SKILL.md</code> files, and an optional
        <code class="text-12-mono">.mcp.json</code> — shaped like <code class="text-12-mono">kyashrathore/plugins</code>.
      </p>
      <div class="flex flex-wrap items-end gap-2">
        <label class="grid min-w-56 flex-1 gap-1">
          <span class="text-11-medium text-text-weaker">GitHub repository</span>
          <input
            class={FIELD}
            placeholder="owner/repository"
            aria-label="GitHub repository"
            value={slug()}
            onInput={(event) => setSlug(event.currentTarget.value)}
          />
        </label>
        <label class="grid w-40 gap-1">
          <span class="text-11-medium text-text-weaker">Ref (optional)</span>
          <input
            class={FIELD}
            placeholder="main"
            aria-label="Ref"
            value={ref()}
            onInput={(event) => setRef(event.currentTarget.value)}
          />
        </label>
        <Button type="submit" size="normal" variant="primary" disabled={busy()}>
          {busy() ? "Checking…" : "Add source"}
        </Button>
        <Button type="button" size="normal" variant="ghost" onClick={() => props.onCancel()}>Cancel</Button>
      </div>
      <Show when={props.organizationAllowed}>
        <label class="flex items-center gap-2 text-12-regular text-text-weak">
          <input
            type="checkbox"
            checked={organization()}
            onChange={(event) => setOrganization(event.currentTarget.checked)}
          />
          Add for everyone in {props.organizationName ?? "the organization"}
        </label>
      </Show>
      <Show when={error()}>
        {(message) => (
          <div role="alert" class="grid gap-1 text-12-regular text-icon-critical-base">
            <span>{message()}</span>
            <For each={diagnostics()}>
              {(diagnostic) => <span class="text-12-mono text-text-weak">{diagnostic.relativePath}: {diagnostic.message}</span>}
            </For>
          </div>
        )}
      </Show>
    </form>
  )
}
