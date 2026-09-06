/**
 * Wraps a value in single quotes for a POSIX `sh`/`bash`/`zsh` command line.
 * Every other byte — backslashes, newlines, $, backticks, spaces, globs — is
 * already literal inside single quotes and is passed through unchanged.
 *
 * Composes: quoting an already-quoted string again yields a correctly
 * double-quoted argument, which the sandbox boot-script callers rely on. Pure
 * string math with no `node:` import, so it is safe in the renderer and on
 * workerd.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
