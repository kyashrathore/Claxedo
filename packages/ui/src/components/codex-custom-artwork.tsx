/** Shared Codex control geometry; distinct from OpenCode’s source artwork. */
export const CODEX_CUSTOM_ARTWORK = {
  "diff-split": `<rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/><path d="M10 4.75V15.25" stroke="currentColor" stroke-width="1"/><rect x="4.75" y="6" width="3.5" height="8" rx="0.75" fill="var(--text-diff-delete-base)"/><rect x="11.75" y="6" width="3.5" height="8" rx="0.75" fill="var(--text-diff-add-base)"/>`,
  "diff-unified": `<rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/><path d="M3.75 10H16.25" stroke="currentColor" stroke-width="1"/><rect x="5" y="5.75" width="10" height="2.5" rx="0.75" fill="var(--text-diff-delete-base)"/><rect x="5" y="11.75" width="10" height="2.5" rx="0.75" fill="var(--text-diff-add-base)"/>`,
  "expand-all": `<path d="M6 8V3.5M6 3.5L3.75 5.75M6 3.5L8.25 5.75M6 12V16.5M6 16.5L3.75 14.25M6 16.5L8.25 14.25M10.5 6.5H16M10.5 10H14.5M10.5 13.5H16" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"/>`,
  "collapse-all": `<path d="M6 3.5V8M6 8L3.75 5.75M6 8L8.25 5.75M6 16.5V12M6 12L3.75 14.25M6 12L8.25 14.25M10.5 6.5H16M10.5 10H14.5M10.5 13.5H16" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"/>`,
} as const
