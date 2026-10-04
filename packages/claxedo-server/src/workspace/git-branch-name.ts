/**
 * Whether `name` is a branch git would accept (`git check-ref-format --branch`).
 * A cloud workspace's branch is fetched and checked out at every boot, so a
 * name git refuses would fail every boot of the workspace instead of its create.
 */
export function isGitBranchName(name: string) {
  if (!name || name === "HEAD" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false
  // Control characters, space, and the characters git reserves for revision syntax and globs.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false
  return name.split("/").every((component) => !component.startsWith(".") && !component.endsWith(".lock"))
}
