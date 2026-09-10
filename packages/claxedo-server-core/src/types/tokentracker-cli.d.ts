// tokentracker-cli ships no type declarations. The shape stays unproven here on
// purpose: `isPricingModule` checks it at runtime, and a declared shape would be
// an unchecked claim about a third-party module the bundle loads on demand.
declare module "tokentracker-cli/src/lib/pricing/index.js" {
  const pricing: unknown
  export default pricing
}
