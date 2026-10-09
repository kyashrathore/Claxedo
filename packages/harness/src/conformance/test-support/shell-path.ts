export function shellPath(file: string): string {
  return file.replaceAll("\\", "/")
}
