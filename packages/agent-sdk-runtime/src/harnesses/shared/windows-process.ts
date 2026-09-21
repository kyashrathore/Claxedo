
/**
 * Whether this binary is a Windows .cmd/.bat launcher, which CreateProcess
 * cannot execute directly — it must be routed through the shell. That is the
 * launcher shape an npm install puts on a Windows PATH for codex and for ACP
 * CLIs alike.
 */
export function isWindowsShimBinary(binary: string) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)
}
