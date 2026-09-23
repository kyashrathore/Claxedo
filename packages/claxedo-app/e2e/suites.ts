/** Shared by Playwright selection and the offline discovery check. */
export const suiteGrep = {
  core: /@core/,
  live: /@live/,
  marketing: /@marketing/,
  all: undefined,
} satisfies Record<string, RegExp | undefined>

export const subSelectorTags = [
  "tier-real",
  "documents-release-canary",
  "documents-rich-canary",
  "documents-unsigned-local-canary",
  "first-interaction",
  "surface-desktop",
  "surface-web",
] as const
