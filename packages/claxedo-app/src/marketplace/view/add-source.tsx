import { createSignal, For, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { PluginSourceError, type PluginSourceDiagnostic, type PluginSourceInput } from "@/server"
import { FormDrawer, TextField } from "@/ui"
import { marketplaceDictionary } from "../i18n"

const CODE = "text-12-mono"

function SourceShape(): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <>
      {t("marketplace.source.shapeLead")} <code class={CODE}>plugin.json</code> {t("marketplace.source.shapeSchema")}{" "}
      <code class={CODE}>skills/&lt;name&gt;/SKILL.md</code> {t("marketplace.source.shapeFiles")}{" "}
      <code class={CODE}>.mcp.json</code> {t("marketplace.source.shapeLike")}{" "}
      <a class="text-text-interactive-base" href="https://github.com/kyashrathore/plugins" target="_blank" rel="noopener noreferrer">
        <code class={CODE}>kyashrathore/plugins</code>
      </a>
      .
    </>
  )
}

function createSourceForm(onAdd: (input: PluginSourceInput) => Promise<void>, invalidSlug: () => string) {
  const [slug, setSlug] = createSignal("")
  const [ref, setRef] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [diagnostics, setDiagnostics] = createSignal<readonly PluginSourceDiagnostic[]>([])
  const [busy, setBusy] = createSignal(false)
  const submit = async () => {
    setError(undefined)
    setDiagnostics([])
    const [owner, repository, ...rest] = slug().trim().split("/")
    if (!owner || !repository || rest.length > 0) {
      setError(invalidSlug())
      return
    }
    setBusy(true)
    try {
      const trimmedRef = ref().trim()
      await onAdd({ owner, repository, ...(trimmedRef ? { ref: trimmedRef } : {}) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      if (cause instanceof PluginSourceError) setDiagnostics(cause.diagnostics)
    } finally {
      setBusy(false)
    }
  }
  return { slug, setSlug, ref, setRef, error, diagnostics, busy, submit }
}

export function AddSourceDrawer(props: {
  readonly onAdd: (input: PluginSourceInput) => Promise<void>
  readonly onCancel: () => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const form = createSourceForm(props.onAdd, () => t("marketplace.source.invalid"))
  return (
    <FormDrawer
      title={t("marketplace.source.add")}
      description={<SourceShape />}
      submitLabel={t("marketplace.source.add")}
      busyLabel={t("marketplace.source.checking")}
      cancelLabel={t("marketplace.cancel")}
      busy={form.busy()}
      canSubmit={form.slug().trim().length > 0}
      error={form.error()}
      onSubmit={() => void form.submit()}
      onCancel={() => props.onCancel()}
    >
      <TextField
        label={t("marketplace.source.repository")}
        placeholder={t("marketplace.source.repositoryPlaceholder")}
        value={form.slug()}
        onChange={form.setSlug}
        autofocus
      />
      <TextField label={t("marketplace.source.refOptional")} placeholder="main" value={form.ref()} onChange={form.setRef} />
      <For each={form.diagnostics()}>
        {(diagnostic) => (
          <p class="text-12-mono text-text-weak">
            {diagnostic.relativePath}: {diagnostic.message}
          </p>
        )}
      </For>
    </FormDrawer>
  )
}
