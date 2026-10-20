import { nextIdleSlice } from "@/lib/idle"

export async function renderMermaidSvg(source: string): Promise<string> {
  await nextIdleSlice()
  const pele = await import("pele/lazy")
  await pele.load(pele.detectType(source))
  await nextIdleSlice()
  return pele.render(source).svg
}
