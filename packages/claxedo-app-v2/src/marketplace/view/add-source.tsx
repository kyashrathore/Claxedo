import { createSignal, For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { PluginSourceError, type PluginSourceDiagnostic, type PluginSourceInput } from "@/server"
import { Button } from "@/ui"
import { marketplaceDictionary } from "../i18n"

const FIELD =
  "h-7 w-full rounded-md border border-border-weak-base bg-surface-base px-2 py-0 text-13-regular text-text-base"
const CODE = "text-12-mono"

function SourceShape(): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <p class="text-12-regular text-text-weak">
      {t("marketplace.source.shapeLead")} <code class={CODE}>plugin.json</code> {t("marketplace.source.shapeSchema")}{" "}
      <code class={CODE}>skills/&lt;name&gt;/SKILL.md</code> {t("marketplace.source.shapeFiles")}{" "}
      <code class={CODE}>.mcp.json</code> {t("marketplace.source.shapeLike")}{" "}
      <a
        class="text-text-interactive-base hover:underline"
        href="https://github.com/kyashrathore/plugins"
        target="_blank"
        rel="noopener noreferrer"
      >
        <code class={CODE}>kyashrathore/plugins</code>
      </a>
      .
    </p>
  )
}

function SourceFailure(props: { readonly message: string; readonly diagnostics: readonly PluginSourceDiagnostic[] }) {
  return (
    <div role="alert" class="grid gap-1 text-12-regular text-icon-critical-base">
      <span>{props.message}</span>
      <For each={props.diagnostics}>
        {(diagnostic) => (
          <span class="text-12-mono text-text-weak">
            {diagnostic.relativePath}: {diagnostic.message}
          </span>
        )}
      </For>
    </div>
  )
}

function createSourceForm(onAdd: (input: PluginSourceInput) => Promise<void>, invalidSlug: () => string) {
  const [slug, setSlug] = createSignal("")
  const [ref, setRef] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [diagnostics, setDiagnostics] = createSignal<readonly PluginSourceDiagnostic[]>([])
  const [busy, setBusy] = createSignal(false)
  const submit = async (event: Event) => {
    event.preventDefault()
    setError(undefined)
    setDiagnostics([])
    const [owner, repository, ...rest] = slug().trim().split("/")
    if (!owner || !repository || rest.length > 0) return setError(invalidSlug())
    setBusy(true)
    try {
      const trimmedRef = ref().trim()
      await onAdd({ owner, repository, ...(trimmedRef ? { ref: trimmedRef } : {}) })
      setSlug("")
      setRef("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      if (cause instanceof PluginSourceError) setDiagnostics(cause.diagnostics)
    } finally {
      setBusy(false)
    }
  }
  return { slug, setSlug, ref, setRef, error, diagnostics, busy, submit }
}

export function AddSourceForm(props: {
  readonly onAdd: (input: PluginSourceInput) => Promise<void>
  readonly onCancel: () => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const form = createSourceForm(props.onAdd, () => t("marketplace.source.invalid"))
  return (
    <form
      data-component="agent-plugin-add-source"
      aria-label={t("marketplace.source.add")}
      class="grid gap-2 rounded-lg border border-border-weak-base bg-surface-inset-base p-3"
      onSubmit={(event) => void form.submit(event)}
    >
      <SourceShape />
      <div class="flex flex-wrap items-end gap-2">
        <label class="grid min-w-56 flex-1 gap-1">
          <span class="text-11-medium text-text-weaker">{t("marketplace.source.repository")}</span>
          <input
            class={FIELD}
            placeholder={t("marketplace.source.repositoryPlaceholder")}
            aria-label={t("marketplace.source.repository")}
            value={form.slug()}
            onInput={(event) => form.setSlug(event.currentTarget.value)}
          />
        </label>
        <label class="grid w-40 gap-1">
          <span class="text-11-medium text-text-weaker">{t("marketplace.source.refOptional")}</span>
          <input
            class={FIELD}
            placeholder="main"
            aria-label={t("marketplace.source.ref")}
            value={form.ref()}
            onInput={(event) => form.setRef(event.currentTarget.value)}
          />
        </label>
        <Button type="submit" size="normal" variant="primary" disabled={form.busy()}>
          {form.busy() ? t("marketplace.source.checking") : t("marketplace.source.add")}
        </Button>
        <Button type="button" size="normal" variant="ghost" onClick={() => props.onCancel()}>
          {t("marketplace.cancel")}
        </Button>
      </div>
      <Show when={form.error()}>
        {(message) => <SourceFailure message={message()} diagnostics={form.diagnostics()} />}
      </Show>
    </form>
  )
}
