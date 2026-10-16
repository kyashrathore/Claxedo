export function toolErrorInputText(input: Record<string, unknown>) {
  return Object.keys(input).length ? JSON.stringify(input, null, 2) : undefined
}
