import type { ErrorMessages } from "./model"

export default {
  auth: ["Logg inn på nytt", "Innloggingen har utløpt eller blitt avvist. Logg inn på nytt for å fortsette."],
  rate_limit: ["For mange forespørsler", "Serveren begrenser forespørsler. Vent litt, og prøv igjen."],
  network: ["Får ikke kontakt med serveren", "Serveren kunne ikke nås. Sjekk tilkoblingen, og prøv igjen."],
  not_found: ["Ikke funnet", "Dette finnes ikke lenger. Det kan ha blitt slettet."],
  conflict: ["Endret et annet sted", "Dette ble endret et annet sted først. Last inn på nytt, og prøv igjen."],
  invalid: ["Forespørsel avvist", "Serveren avviste denne forespørselen som ugyldig."],
  internal: ["Noe gikk galt", "Det oppstod en uventet feil. Prøv igjen."],
  signIn: "Logg inn",
  retry: "Prøv igjen",
  reload: "Last inn på nytt",
} satisfies ErrorMessages
