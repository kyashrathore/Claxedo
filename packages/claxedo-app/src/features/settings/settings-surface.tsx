import { createSignal } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { SETTINGS_DEFAULT_SECTION, settingsRoute, settingsSectionFromPath } from "@/platform/settings/route"

/**
 * Whether the shell is showing settings, and which section.
 *
 * The URL answers, the way it does for Tasks and Marketplace: the route is
 * matched by an outlet that draws nothing, and the shell reads the path to
 * decide what the rail lists and what the workbench column draws. So the
 * workbench is never unmounted for it, and on the web the section is a link
 * that survives a reload. The desktop renderer runs a MemoryRouter, where the
 * same navigation happens with no address bar to show it.
 *
 * Closing returns to wherever the user was rather than to `/`, because
 * settings is a place they stepped aside to and the session they left is still
 * mounted behind it.
 */
const settingsSurfaceInput = {
  name: "SettingsSurface",
  gate: false,
  init: () => {
    const location = useLocation()
    const navigate = useNavigate()
    const [returnTo, setReturnTo] = createSignal("/")
    const section = () => settingsSectionFromPath(location.pathname)
    const isOpen = () => section() !== undefined

    return {
      section,
      isOpen,
      open: (next: string = SETTINGS_DEFAULT_SECTION) => {
        if (!isOpen()) setReturnTo(`${location.pathname}${location.search}`)
        navigate(settingsRoute(next))
      },
      close: () => navigate(returnTo()),
    }
  },
}

export const { use: useSettingsSurface, useOptional: useSettingsSurfaceOptional, provider: SettingsSurfaceProvider } =
  createSimpleContext<ReturnType<typeof settingsSurfaceInput.init>, Record<never, never>>(settingsSurfaceInput)
