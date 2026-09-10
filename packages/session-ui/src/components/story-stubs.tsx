/**
 * Inert stand-ins for the contexts a story mounts but does not exercise.
 * Styling stays on theme classes: this file is scanned by check-theme-tokens,
 * unlike the `.stories.tsx` files that consume it.
 */
export function FileStub() {
  return <div class="p-2 text-12-regular text-text-weak">File viewer stub</div>
}
