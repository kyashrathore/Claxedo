import type { Component, JSX } from "solid-js"

type SettingsDialog = Component<{ initialTab?: string }>

export async function openSettingsProviders(
  dialog: { show: (element: () => JSX.Element) => unknown },
  load: () => Promise<{ DialogSettings: SettingsDialog }>,
) {
  const module = await load()
  dialog.show(() => <module.DialogSettings initialTab="providers" />)
}
