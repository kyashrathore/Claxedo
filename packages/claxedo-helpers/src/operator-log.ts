let sink: ((line: string) => void) | undefined

/**
 * Where a runtime's own warning and error lines also go, apart from the stderr
 * its harness children may share: a sandbox host forwards only this log to
 * operators, so nothing a child process prints reaches it.
 */
export function setOperatorLogSink(next: ((line: string) => void) | undefined) {
  sink = next
}

/** A warning or error line: on stderr like every log line, and in the operator log when there is one. */
export function writeOperatorLine(line: string) {
  process.stderr.write(line)
  sink?.(line)
}
