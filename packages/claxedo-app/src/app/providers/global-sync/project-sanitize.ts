/**
 * Strips icon URL/override fields before a project enters global state, so a
 * server-provided icon reference can never leak into persisted client state.
 *
 * Typed structurally rather than against the SDK's `Project` on purpose: the
 * function only touches `icon`, and staying off the SDK import keeps this file
 * out of the sdk-importing-files debt ratchet.
 */

type IconCarrier = { icon?: { url?: unknown; override?: unknown } }

export function sanitizeProject<T extends IconCarrier>(project: T): T {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  } as T
}
