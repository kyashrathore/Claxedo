// The Solid entry imports its stylesheet for its side effect. The app program
// gets this declaration from `vite/client`; this package's own typecheck has no
// bundler types, so it needs its own.
declare module "*.css" {
  const url: string
  export default url
}
