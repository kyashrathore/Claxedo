import { createSignal, Show, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { toAppError } from "@/server"
import { Field, FormDrawer, Select, useDialog } from "@/ui"
import { marketplaceDictionary } from "../i18n"
import { PluginIconTile } from "../view/plugin-icon"
import { AppPluginAccessList } from "./access-list"
import type { AppPluginEntry } from "./model"

export type ConsentMode = "install" | "turnOn"

type ConsentProps = {
  readonly entry: AppPluginEntry
  readonly mode: ConsentMode
  readonly submit: (version: string) => Promise<void>
  readonly done: () => void
}

function versionsOf(entry: AppPluginEntry): readonly string[] {
  return entry.listing?.versions ?? [entry.install?.version ?? entry.manifest.version]
}

function createConsent(props: ConsentProps) {
  const errorCopy = useErrorCopy("marketplace")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const run = async (version: string) => {
    setError(undefined)
    setBusy(true)
    try {
      await props.submit(version)
      props.done()
    } catch (cause) {
      setError(errorCopy(toAppError(cause)).message)
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, run }
}

function Identity(props: { readonly entry: AppPluginEntry }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <div class="flex items-start gap-3 border-b border-border-weak-base pb-3">
      <PluginIconTile name={props.entry.name} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-13-medium text-text-strong">{props.entry.name}</div>
        <p class="mt-0.5 text-12-regular text-text-weak">{props.entry.description ?? t("marketplace.noDescription")}</p>
      </div>
    </div>
  )
}

function VersionField(props: { readonly versions: readonly string[]; readonly current: string; readonly onSelect: (version: string) => void }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const label = (version: string) => (version === props.versions[0] ? t("marketplace.app.install.latest", { version }) : version)
  return (
    <Field>
      <Field.Label>{t("marketplace.app.install.version")}</Field.Label>
      <Select
        options={[...props.versions]}
        current={props.current}
        value={(version) => version}
        label={label}
        onSelect={(next) => next && props.onSelect(next)}
        triggerProps={{ "aria-label": t("marketplace.app.install.version") }}
      />
    </Field>
  )
}

function ConsentDrawer(props: ConsentProps): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const dialog = useDialog()
  const versions = versionsOf(props.entry)
  const [version, setVersion] = createSignal(versions[0] ?? props.entry.manifest.version)
  const consent = createConsent(props)
  const install = props.mode === "install"
  return (
    <FormDrawer
      title={t(install ? "marketplace.app.install.title" : "marketplace.app.enable.title", { name: props.entry.name })}
      description={t(install ? "marketplace.app.install.description" : "marketplace.app.enable.description")}
      submitLabel={t(install ? "marketplace.app.install.submit" : "marketplace.app.enable.submit")}
      busyLabel={t(install ? "marketplace.app.install.busy" : "marketplace.app.enable.busy")}
      cancelLabel={t("marketplace.cancel")}
      busy={consent.busy()}
      error={consent.error()}
      onSubmit={() => void consent.run(version())}
      onCancel={() => dialog.close()}
    >
      <Identity entry={props.entry} />
      <Show when={install && versions.length > 1}>
        <VersionField versions={versions} current={version()} onSelect={setVersion} />
      </Show>
      <AppPluginAccessList manifest={props.entry.manifest} heading="field" />
    </FormDrawer>
  )
}

export function useConsentDrawer() {
  const dialog = useDialog()
  return (entry: AppPluginEntry, mode: ConsentMode, submit: (version: string) => Promise<void>) =>
    new Promise<void>((resolve) => {
      void dialog.show(() => <ConsentDrawer entry={entry} mode={mode} submit={submit} done={() => dialog.close()} />, resolve)
    })
}
