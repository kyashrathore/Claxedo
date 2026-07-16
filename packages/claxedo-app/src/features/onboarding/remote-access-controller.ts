import { createMemo, createResource } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { usePlatform } from "@/platform/runtime/platform-provider"
import type { OnboardingFunnelEvent } from "./funnel"
import { createRemoteAccessClient } from "./remote-access-api"
import {
  remoteAccessAvailability,
  remoteAccessClientId,
  remoteAccessWorkspaceLink,
} from "./remote-access-state"

export function useRemoteAccessController(input: {
  serverUrl: string
  emit?: (event: Extract<OnboardingFunnelEvent, { name: "remote_access_enabled" | "second_device_open" }>) => void
}) {
  const platform = usePlatform()
  const client = createMemo(() => createRemoteAccessClient({
    request: (path, init) => authFetch(new URL(path, getClaxedoServerUrl()), init),
    emit: input.emit,
  }))
  const status = useQuery(() => ({
    queryKey: ["claxedo", "remote-access", "status", input.serverUrl] as const,
    queryFn: () => client().status(),
    retry: false,
  }))
  const devices = useQuery(() => ({
    queryKey: ["claxedo", "remote-access", "devices", input.serverUrl] as const,
    queryFn: () => client().devices(),
    enabled: status.data?.hostedSignedIn === true,
    retry: false,
  }))
  const [startAtLogin, startAtLoginActions] = createResource(
    () => platform.platform === "desktop",
    async (desktop) => desktop ? await platform.getStartAtLogin?.() ?? false : false,
  )
  const availability = createMemo(() => remoteAccessAvailability({
    deviceLoginConfigured: status.data?.deviceLoginConfigured === true,
    relayConfigured: status.data?.relayConfigured === true,
    hostedSignedIn: status.data?.hostedSignedIn === true,
    enabled: status.data?.enabled === true,
    secondDeviceOpen: status.data?.secondDeviceOpen === true,
  }))
  const workspaceLink = createMemo(() => {
    const workspaceId = devices.data?.flatMap((device) => device.workspaceIds)[0]
    if (!workspaceId || typeof window === "undefined") return
    const origin = /^https?:$/.test(window.location.protocol) && !["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? window.location.origin
      : "https://app.claxedo.com"
    return remoteAccessWorkspaceLink({
      appOrigin: origin,
      workspaceId,
      sourceClientId: remoteAccessClientId(),
    })
  })

  return {
    status,
    devices,
    availability,
    workspaceLink,
    startAtLogin: () => startAtLogin() ?? false,
    async setStartAtLogin(enabled: boolean) {
      startAtLoginActions.mutate(enabled)
      await platform.setStartAtLogin?.(enabled)
    },
    async enable() {
      await client().enable({
        displayName: navigator.platform || "This machine",
        startAtLogin: startAtLogin() ?? false,
      })
      await Promise.all([status.refetch(), devices.refetch()])
    },
    async revoke(hostId: string) {
      await client().revoke(hostId)
      await Promise.all([status.refetch(), devices.refetch()])
    },
  }
}
