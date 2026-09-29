/**
 * The site's own icon set, drawn for claxedo.com in the Codex visual language:
 * a 20-unit grid, a 1.25 stroke with round caps and joins, 2–2.5 unit corner
 * radii, and marks that sit inside a 14–16 unit optical box. Names follow the
 * app's semantic icon names so the demo reads like the app. See LICENSE.md.
 */
export const ICONS = {
  "layout-left-partial": `<rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M8 4v12"/>`,
  "layout-right-partial": `<rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M12 4v12"/>`,
  "layout-right-full": `<rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M12 4v12"/><rect x="12.75" y="4.9" width="3.35" height="10.2" rx="1.6" fill="currentColor" stroke="none"/>`,
  "close-small": `<path d="M6.5 6.5l7 7M13.5 6.5l-7 7"/>`,
  plus: `<path d="M10 4v12M4 10h12"/>`,
  "plus-small": `<path d="M10 5.5v9M5.5 10h9"/>`,
  terminal: `<rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M6.5 8l2 2-2 2M10.5 12h3"/>`,
  "chevron-down": `<path d="M6 8l4 4 4-4"/>`,
  "chevron-right": `<path d="M8 6l4 4-4 4"/>`,
  "chevron-double-left": `<path d="M10 6l-4 4 4 4M14.5 6l-4 4 4 4"/>`,
  "chevron-double-right": `<path d="M5.5 6l4 4-4 4M10 6l4 4-4 4"/>`,
  review: `<rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><path d="M7 8h6M7 11h3.5"/>`,
  changes: `<path d="M7 15V5M4.5 7.5L7 5l2.5 2.5M13 5v10M10.5 12.5L13 15l2.5-2.5"/>`,
  file: `<path d="M11 3H6.5A1.5 1.5 0 0 0 5 4.5v11A1.5 1.5 0 0 0 6.5 17h7a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M11 3v4h4"/>`,
  "document-text": `<path d="M11 3H6.5A1.5 1.5 0 0 0 5 4.5v11A1.5 1.5 0 0 0 6.5 17h7a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M11 3v4h4M8 10.5h4M8 13.25h4"/>`,
  expand: `<path d="M11.5 4.5h4v4M8.5 15.5h-4v-4M15.5 4.5L11 9M4.5 15.5L9 11"/>`,
  collapse: `<path d="M8.5 4.5v4h-4M11.5 15.5v-4h4M8.5 8.5l-4-4M11.5 11.5l4 4"/>`,
  "expand-all": `<path d="M6 4v12M3.75 6.25L6 4l2.25 2.25M3.75 13.75L6 16l2.25-2.25M10.5 6.5H16M10.5 10h3.5M10.5 13.5H16"/>`,
  split: `<rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M10 4v12M5.5 7.5h2M12.5 7.5h2M5.5 10h2M12.5 10h2"/>`,
  "open-external": `<path d="M8.5 5H6.5A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-2"/><path d="M11 5h4v4M15 5l-5.5 5.5"/>`,
  folder: `<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.4l1.6 1.75h6A1.5 1.5 0 0 1 17 8.25v6.25A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z"/>`,
  "folder-add": `<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.4l1.6 1.75h6A1.5 1.5 0 0 1 17 8.25v6.25A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z"/><path d="M10 9.25v4.5M7.75 11.5h4.5"/>`,
  marketplace: `<rect x="3.5" y="3.5" width="5" height="5" rx="1.25"/><rect x="11.5" y="3.5" width="5" height="5" rx="1.25"/><rect x="3.5" y="11.5" width="5" height="5" rx="1.25"/><path d="M14 11.5v5M11.5 14h5"/>`,
  checklist: `<path d="M3.5 6l1.5 1.5L7.5 5M3.5 13l1.5 1.5L7.5 12M10.5 6.25h6M10.5 13.25h6"/>`,
  monitor: `<rect x="3" y="4" width="14" height="9.5" rx="2"/><path d="M7.5 16.5h5M10 13.5v3"/>`,
  server: `<rect x="3.5" y="4" width="13" height="5" rx="1.75"/><rect x="3.5" y="11" width="13" height="5" rx="1.75"/><path d="M6.5 6.5h1M6.5 13.5h1"/>`,
  cloud: `<path d="M6.25 15.5h7.5a3.25 3.25 0 0 0 .35-6.48 4.4 4.4 0 0 0-8.45.9A2.85 2.85 0 0 0 6.25 15.5z"/>`,
  browser: `<rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M3 7.5h14"/>`,
  phone: `<rect x="6" y="3" width="8" height="14" rx="2"/><path d="M9.25 14.5h1.5"/>`,
  warning: `<path d="M8.7 4.25a1.5 1.5 0 0 1 2.6 0l5.6 9.75A1.5 1.5 0 0 1 15.6 16.25H4.4A1.5 1.5 0 0 1 3.1 14z"/><path d="M10 8.25v3.25M10 13.75v.25"/>`,
  gauge: `<path d="M4 14.5a6 6 0 1 1 12 0"/><path d="M10 14.5l3-3.5"/>`,
  "settings-gear": `<path d="M14.94 8.22L16.63 8.72V11.28L14.94 11.78L14.75 12.24L15.59 13.79L13.79 15.59L12.24 14.75L11.78 14.94L11.28 16.63H8.72L8.22 14.94L7.76 14.75L6.21 15.59L4.41 13.79L5.25 12.24L5.06 11.78L3.37 11.28V8.72L5.06 8.22L5.25 7.76L4.41 6.21L6.21 4.41L7.76 5.25L8.22 5.06L8.72 3.37H11.28L11.78 5.06L12.24 5.25L13.79 4.41L15.59 6.21L14.75 7.76Z"/><circle cx="10" cy="10" r="2.25"/>`,
  help: `<circle cx="10" cy="10" r="7"/><path d="M8 8.25a2 2 0 1 1 2.75 1.85c-.45.2-.75.65-.75 1.15v.5M10 13.75v.25"/>`,
  "three-dots": `<circle cx="5" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/>`,
  branch: `<circle cx="6" cy="5" r="1.75"/><circle cx="6" cy="15" r="1.75"/><circle cx="14" cy="6.5" r="1.75"/><path d="M6 6.75v6.5M14 8.25c0 3.25-3 4-7 5"/>`,
  github: `<path d="M5 15.5V5A1.5 1.5 0 0 1 6.5 3.5H15v10H6.5A1.5 1.5 0 0 0 5 15a1.5 1.5 0 0 0 1.5 1.5H15"/><path d="M8.5 3.5v5.5l1.5-1 1.5 1V3.5"/>`,
  "scroll-to-latest": `<path d="M10 4v11M5.5 10.5L10 15l4.5-4.5"/>`,
  shield: `<path d="M10 3l6 2.5v4c0 3.75-2.6 6.25-6 7.5-3.4-1.25-6-3.75-6-7.5v-4z"/>`,
  "magnifying-glass": `<circle cx="9" cy="9" r="5"/><path d="M13 13l3.5 3.5"/>`,
  send: `<path d="M10 15.5v-11M5.75 8.75L10 4.5l4.25 4.25"/>`,
  check: `<path d="M5 10.5l3.25 3.25L15 6.5"/>`,
} as const

export type IconName = keyof typeof ICONS

export const iconId = (name: IconName) => `icon-${name}`

export const iconSymbol = (name: IconName) =>
  `<symbol id="${iconId(name)}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</symbol>`
