export function shouldInvalidateBootstrapFresh(type: string) {
  return type === "server.instance.disposed"
}
