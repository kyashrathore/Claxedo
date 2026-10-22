export function keepStdoutForProtocol(): (line: string) => boolean {
  const protocolOut = process.stdout.write.bind(process.stdout)
  process.stdout.write = process.stderr.write.bind(process.stderr)
  console.log = (...args: unknown[]) => console.error(...args)
  console.info = (...args: unknown[]) => console.error(...args)
  console.debug = (...args: unknown[]) => console.error(...args)
  return (line) => protocolOut(line)
}
