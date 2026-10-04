declare module "*.template.sh" {
  const text: string
  export default text
}

declare module "*.template.txt" {
  const text: string
  export default text
}

declare module "*?raw" {
  const text: string
  export default text
}
