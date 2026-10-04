import type { ErrorMessages } from "./model"

export default {
  auth: ["Log ind igen", "Dit login er udløbet eller blevet afvist. Log ind igen for at fortsætte."],
  forbidden: ["Ikke tilladt", "Din konto har ikke adgang til dette. Bed ejeren om adgang."],
  rate_limit: ["For mange forespørgsler", "Serveren begrænser forespørgsler. Vent et øjeblik, og prøv igen."],
  network: ["Kan ikke nå serveren", "Serveren kunne ikke nås. Tjek forbindelsen, og prøv igen."],
  not_found: ["Ikke fundet", "Dette findes ikke længere. Det er muligvis blevet slettet."],
  conflict: ["Ændret et andet sted", "Dette blev først ændret et andet sted. Genindlæs, og prøv igen."],
  invalid: ["Forespørgsel afvist", "Serveren afviste denne forespørgsel som ugyldig."],
  internal: ["Noget gik galt", "Der opstod en uventet fejl. Prøv igen."],
  signIn: "Log ind",
  retry: "Prøv igen",
  reload: "Genindlæs",
} satisfies ErrorMessages
