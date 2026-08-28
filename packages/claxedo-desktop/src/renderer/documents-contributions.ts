export async function loadDesktopDocumentsContributions() {
  const module = await import("@/app/integrations/documents-content-surfaces")
  return { contentSurfaces: module.documentsContentSurfaces }
}
