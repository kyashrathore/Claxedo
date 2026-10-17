export function validationPattern(source: string | undefined): RegExp | undefined {
  if (source === undefined) return undefined
  try {
    return new RegExp(`^(?:${source})$`, "u")
  } catch (error) {
    console.warn("A surface text field carries a validation pattern that is not a regular expression; it is not validated", { source, error })
    return undefined
  }
}
