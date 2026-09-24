import { createStore } from "solid-js/store"

export type ComposerRefs = ReturnType<typeof createComposerRefs>

export function createComposerRefs() {
  const [refs, setRefs] = createStore<{
    editor?: HTMLDivElement
    root?: HTMLDivElement
    scroll?: HTMLDivElement
    fileInput?: HTMLInputElement
  }>({})
  return {
    editor: () => refs.editor,
    root: () => refs.root,
    scroll: () => refs.scroll,
    fileInput: () => refs.fileInput,
    setEditor: (element: HTMLDivElement) => setRefs("editor", element),
    setRoot: (element: HTMLDivElement) => setRefs("root", element),
    setScroll: (element: HTMLDivElement) => setRefs("scroll", element),
    setFileInput: (element: HTMLInputElement) => setRefs("fileInput", element),
  }
}
