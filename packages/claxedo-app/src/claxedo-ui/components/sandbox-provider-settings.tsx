/**
 * Sandbox Provider Settings — select default VM provider, view credential
 * status, and manage network policies.
 */

import { createSignal, createResource, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { usePlatform } from "@opencode-ai/claxedo-app"
import { useGlobalSDK } from "@/context/global-sdk"
import { NetworkPolicySettings } from "./network-policy-settings"

type CredentialSource = "managed" | "config" | "none"

interface ProviderInfo {
  id: string
  label: string
  fields: { key: string; label: string; secret?: boolean }[]
  configured: boolean
  source: CredentialSource
  default: boolean
}

export function SandboxProviderSettings(props: { workspaceId?: string }) {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const request = platform.fetch ?? globalThis.fetch
  const base = sdk.url

  const [settingDefault, setSettingDefault] = createSignal(false)

  const [providers, { refetch }] = createResource(async () => {
    const res = await request(`${base}/api/workspace/providers`)
    if (!res.ok) return { providers: [] as ProviderInfo[], default_provider: "" }
    return await res.json() as { providers: ProviderInfo[]; default_provider: string }
  })

  async function setDefault(id: string) {
    setSettingDefault(true)
    try {
      const res = await request(`${base}/api/workspace/providers/default`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: id }),
      })
      if (res.ok) {
        refetch()
        showToast({ title: "Default provider updated", variant: "success" })
      }
    } finally {
      setSettingDefault(false)
    }
  }

  return (
    <div class="flex flex-col gap-5">
      {/* ── Compute provider selector ──────────────────────────── */}
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <Icon name="server" size="small" class="text-icon-base" />
          <span class="text-sm font-medium text-text-base">Compute Provider</span>
        </div>
        <p class="text-xs text-text-weaker">
          Select the default VM provider for cloud workspaces.
        </p>

        <Show when={providers()}>
          <div class="flex flex-col gap-1">
            <For each={providers()!.providers}>
              {(provider) => (
                <div
                  class="flex items-center justify-between px-3 py-2 rounded bg-surface-inset cursor-pointer hover:bg-surface-base-hover transition-colors"
                  classList={{ "ring-1 ring-primary": provider.default }}
                  onClick={() => {
                    if (provider.configured && !provider.default) setDefault(provider.id)
                  }}
                >
                  <div class="flex items-center gap-2">
                    <div
                      class="size-3.5 rounded-full border-2 flex items-center justify-center"
                      classList={{
                        "border-primary": provider.default,
                        "border-border-base": !provider.default,
                      }}
                    >
                      <Show when={provider.default}>
                        <div class="size-1.5 rounded-full bg-primary" />
                      </Show>
                    </div>
                    <span class="text-sm text-text-base">{provider.label}</span>
                  </div>
                  <Show when={provider.configured}>
                    <span class="text-xs text-success">Connected</span>
                  </Show>
                  <Show when={!provider.configured}>
                    <span class="text-xs text-text-weaker">Not configured</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* ── Network policy ─────────────────────────────────────── */}
      <NetworkPolicySettings workspaceId={props.workspaceId} />
    </div>
  )
}
