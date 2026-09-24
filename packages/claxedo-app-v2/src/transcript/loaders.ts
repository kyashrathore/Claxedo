export async function loadFileComponent() {
  return (await import("./file")).File
}
