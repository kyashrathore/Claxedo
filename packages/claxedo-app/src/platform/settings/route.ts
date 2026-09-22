/** Settings is a page, so every surface that sends the user there navigates. */
export const SETTINGS_ROUTE = "/settings"

/** The default section, and the one a bare `/settings` resolves to. */
export const SETTINGS_DEFAULT_SECTION = "general"

/**
 * The path for one settings section.
 *
 * A section id reaches here from a contributed section as well as from the
 * built-in tabs, so it is encoded: an id with a slash in it would otherwise
 * address a route that does not exist and land the user on the default.
 */
export function settingsRoute(section?: string) {
  return section ? `${SETTINGS_ROUTE}/${encodeURIComponent(section)}` : SETTINGS_ROUTE
}

/**
 * The section a path addresses, or nothing when the path is not settings.
 *
 * Bare `/settings` is the default section rather than a section of its own, so
 * the rail highlights something the moment the surface opens.
 */
export function settingsSectionFromPath(pathname: string): string | undefined {
  if (pathname === SETTINGS_ROUTE) return SETTINGS_DEFAULT_SECTION
  if (!pathname.startsWith(`${SETTINGS_ROUTE}/`)) return undefined
  const section = decodeURIComponent(pathname.slice(SETTINGS_ROUTE.length + 1))
  return section || SETTINGS_DEFAULT_SECTION
}
