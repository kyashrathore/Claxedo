type WorkersSubtle = SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }

function workersSubtle(subtle: SubtleCrypto): subtle is WorkersSubtle {
  return "timingSafeEqual" in subtle
}

const encoder = new TextEncoder()

/** Digests first, so the comparison runs over equal lengths whatever the caller sent and learns nothing from timing. */
export async function apiTokenMatches(presented: string, expected: string) {
  const subtle = crypto.subtle
  if (!workersSubtle(subtle)) throw new Error("The runtime has no constant-time comparison")
  const [a, b] = await Promise.all([subtle.digest("SHA-256", encoder.encode(presented)), subtle.digest("SHA-256", encoder.encode(expected))])
  return subtle.timingSafeEqual(a, b)
}
