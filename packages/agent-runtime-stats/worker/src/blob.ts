export function bytesFromD1(value: number[] | null): Uint8Array<ArrayBuffer> | null {
  return value === null ? null : Uint8Array.from(value)
}
