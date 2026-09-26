const OSC_10_QUERY = /\x1b\]10;\?(?:\x1b\\|\x07)/
const OSC_11_QUERY = /\x1b\]11;\?(?:\x1b\\|\x07)/

function rgbChannels(rgba: number): string {
  return [24, 16, 8].map((shift) => (((rgba >>> shift) & 255) * 257).toString(16).padStart(4, "0")).join("/")
}

export function capabilityResponses(data: string, colors: () => { foreground: number; background: number }): string[] {
  if (!data.includes("\x1b]") && !data.includes("\x1b[")) return []
  const responses: string[] = []
  const foreground = OSC_10_QUERY.test(data)
  const background = OSC_11_QUERY.test(data)
  if (foreground || background) {
    const parsed = colors()
    if (foreground) responses.push(`\x1b]10;rgb:${rgbChannels(parsed.foreground)}\x07`)
    if (background) responses.push(`\x1b]11;rgb:${rgbChannels(parsed.background)}\x07`)
  }
  if (data.includes("\x1b[c") || data.includes("\x1b[0c")) responses.push("\x1b[?64;1;2;4;6;9;15;22;29c")
  if (data.includes("\x1b[>c") || data.includes("\x1b[>0c")) responses.push("\x1b[>0;276;0c")
  if (data.includes("\x1b[?u")) responses.push("\x1b[?0u")
  return responses
}
