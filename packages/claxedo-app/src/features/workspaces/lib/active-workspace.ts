export function resolveActiveDirectory(input: {
  routeDir?: string
  surfaceDir?: string
}) {
  if (input.routeDir) return input.routeDir
  return input.surfaceDir
}
