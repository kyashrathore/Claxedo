import { useI18n, useTranslator } from "@/i18n"
import { useAgeClock } from "@/lib/clock"
import { formatRelativeTime } from "@/lib/relative-time"
import type { Machine } from "@/server"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { blockedKey, offlineCause } from "../machines"

function machineStateKey(machine: Machine): SettingsKey {
  if (machine.paused) return "settings.machines.paused"
  if (!machine.online) return "settings.machines.offline"
  if (!machine.isThisMachine) return "settings.machines.connected"
  return machine.enrolled ? "settings.machines.reachableElsewhere" : "settings.machines.reachableHereOnly"
}

function machineStateTone(machine: Machine): "success" | "warning" | "muted" {
  if (machine.paused) return "warning"
  return machine.online ? "success" : "muted"
}

export function useRelativeAge(at: () => number | undefined): () => string | undefined {
  const i18n = useI18n()
  const now = useAgeClock(at)
  return () => {
    const value = at()
    return value === undefined ? undefined : formatRelativeTime(value, i18n.intlTag(), now())
  }
}

function useMachineFacts(machine: () => Machine): () => readonly string[] {
  const t = useTranslator(settingsDictionary)
  const lastSeen = useRelativeAge(() => machine().enrollment?.lastSeenAt)
  return () => {
    const seen = lastSeen()
    const cause = offlineCause(machine())
    return [t(machineStateKey(machine())), ...(seen ? [t("settings.machines.lastSeen", { time: seen })] : []), ...(cause ? [t(blockedKey(cause))] : [])]
  }
}

export function MachineDot(props: { readonly machine: Machine }) {
  return <span class="settings-dot" data-tone={machineStateTone(props.machine)} aria-hidden="true" />
}

export function MachineStatus(props: { readonly machine: Machine }) {
  const facts = useMachineFacts(() => props.machine)
  return <>{facts().join(" · ")}</>
}
