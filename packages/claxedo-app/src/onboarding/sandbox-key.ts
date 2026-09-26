import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type SandboxProviderFailure, type SandboxProviderOption, type SandboxProviderVerification } from "@/server"
import { useOnboardingText, type OnboardingKey } from "./i18n"

const FAILURE_TEXT: Record<SandboxProviderFailure, OnboardingKey> = {
  missing: "onboarding.sandbox.failure.missing",
  unsupported: "onboarding.sandbox.failure.unsupported",
  rejected: "onboarding.sandbox.failure.rejected",
  unmanaged: "onboarding.sandbox.unmanaged",
  failed: "onboarding.sandbox.failure.failed",
}

export function canSaveSandboxKey(provider: SandboxProviderOption, values: Readonly<Record<string, string>>): boolean {
  return provider.fields.length > 0 && provider.fields.every((field) => (values[field.key] ?? "").trim().length > 0)
}

function createProviderChoice() {
  const server = useServer()
  const catalog = useQuery(() => server.queries.sandboxProviders.catalog())
  const [picked, setPicked] = createSignal<string>()
  const providers = () => catalog.data?.providers ?? []
  const selected = createMemo<SandboxProviderOption | undefined>(() => {
    const id = picked()
    if (id) return providers().find((provider) => provider.id === id)
    return providers().find((provider) => provider.configured) ?? providers()[0]
  })
  return { loading: () => catalog.isPending, unavailable: () => catalog.isError, providers, selected, setPicked }
}

function createKeySave(selected: Accessor<SandboxProviderOption | undefined>) {
  const server = useServer()
  const t = useOnboardingText()
  const [values, setValues] = createSignal<Readonly<Record<string, string>>>({})
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [saved, setSaved] = createSignal<SandboxProviderVerification>()
  const save = async () => {
    const provider = selected()
    if (!provider || !canSaveSandboxKey(provider, values())) return
    setBusy(true)
    setFailure(undefined)
    const outcome = await server.sandboxProviders.saveKey(provider.id, Object.fromEntries(provider.fields.map((field) => [field.key, values()[field.key] ?? ""])))
    setBusy(false)
    if (!outcome.ok) return void setFailure(outcome.reason ?? t(FAILURE_TEXT[outcome.failure]))
    setSaved(outcome.verification ?? { state: "unknown" })
    setValues({})
  }
  const reset = () => {
    setSaved(undefined)
    setFailure(undefined)
  }
  return { values, setValues, busy, failure, saved, save, reset }
}

export function createSandboxKey(onReady: (ready: boolean) => void) {
  const choice = createProviderChoice()
  const key = createKeySave(choice.selected)
  const verdict = () => key.saved() ?? choice.selected()?.verification
  createEffect(() => {
    const provider = choice.selected()
    const state = verdict()?.state
    onReady(provider !== undefined && (state ? state !== "broken" : provider.configured))
  })
  return {
    ...choice,
    ...key,
    verdict,
    pick: (id: string) => {
      choice.setPicked(id)
      key.reset()
    },
  }
}

export type SandboxKey = ReturnType<typeof createSandboxKey>
