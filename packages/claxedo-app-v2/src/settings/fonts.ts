export const UI_FONT_PLACEHOLDER = "System Sans"
export const CODE_FONT_PLACEHOLDER = "System Mono"
export const TERMINAL_FONT_PLACEHOLDER = "JetBrainsMono Nerd Font Mono"

const SANS_STACK = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const TERMINAL_STACK = `"JetBrainsMono Nerd Font Mono", ${MONO_STACK}`

function family(font: string): string {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string, base: string): string {
  const value = font.trim()
  return value ? `${family(value)}, ${base}` : base
}

export const uiFontFamily = (font: string) => stack(font, SANS_STACK)
export const codeFontFamily = (font: string) => stack(font, MONO_STACK)
export const terminalFontFamily = (font: string) => stack(font, TERMINAL_STACK)
