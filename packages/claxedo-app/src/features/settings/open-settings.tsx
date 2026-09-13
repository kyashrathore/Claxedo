import type { Component, JSX } from "solid-js"

type SettingsDialog = Component<{ initialTab?: string }>

/**
 * Opens Settings on one tab from a feature that may not import the dialog.
 *
 * The loader is the caller's, so the dialog stays out of the feature's static
 * graph; `tab` is a tab value the dialog knows — one of its own, or the id of a
 * section contributed through `app/integrations/settings-sections`.
 */
export async function openSettings(
  dialog: { show: (element: () => JSX.Element) => unknown },
  load: () => Promise<{ DialogSettings: SettingsDialog }>,
  tab: string,
) {
  const module = await load()
  dialog.show(() => <module.DialogSettings initialTab={tab} />)
}
