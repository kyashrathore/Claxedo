import type { Component } from "solid-js"

type SettingsDialog = Component<{ initialTab?: string }>

export async function openSettingsProviders(
  dialog: { show: (render: () => unknown) => void },
  load: () => Promise<{ DialogSettings: SettingsDialog }>,
) {
  const module = await load()
  dialog.show(() => <module.DialogSettings initialTab="providers" />)
}
