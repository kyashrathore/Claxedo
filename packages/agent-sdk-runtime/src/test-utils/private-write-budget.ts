/**
 * Time to allow a test for each file it writes through `writePrivateFileAtomic`.
 * On Windows every such write runs an interpreter that compiles the runner with
 * `Add-Type`: 11.5 s for one write on GitHub's 2-core windows-latest runner
 * (unit run 35787260714), 0.3 s on an 8-core box. Elsewhere it is one `open`.
 */
export function privateWriteBudgetMs(writes: number) {
  return 20_000 + writes * (process.platform === "win32" ? 15_000 : 0)
}
