export type CopyResult = { readonly copied: true } | { readonly copied: false; readonly error: unknown }

export async function copyText(text: string): Promise<CopyResult> {
  try {
    await navigator.clipboard.writeText(text)
    return { copied: true }
  } catch (error) {
    console.warn("Text could not be copied to the clipboard", { error })
    return { copied: false, error }
  }
}
