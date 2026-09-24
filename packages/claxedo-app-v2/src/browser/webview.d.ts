import "solid-js"

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      webview: HTMLAttributes<HTMLElement> & { src?: string; partition?: string }
    }
  }
}
