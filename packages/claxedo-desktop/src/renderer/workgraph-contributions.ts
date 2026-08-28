export async function loadDesktopWorkGraphContributions() {
  const module = await import("@/app/integrations/hosted-content-surfaces")
  return { contentSurfaces: module.workGraphContentSurfaces }
}
