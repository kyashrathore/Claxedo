import { AVATAR_COLOR_KEYS } from "./project-colors"

export function getAvatarColors(key?: string) {
  if (key && (AVATAR_COLOR_KEYS as readonly string[]).includes(key)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}
