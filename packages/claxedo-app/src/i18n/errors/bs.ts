import type { ErrorMessages } from "./model"

export default {
  auth: ["Ponovo se prijavite", "Vaša prijava je istekla ili je odbijena. Ponovo se prijavite da nastavite."],
  forbidden: ["Nije dozvoljeno", "Vaš račun nema pristup ovome. Zatražite pristup od vlasnika."],
  rate_limit: ["Previše zahtjeva", "Server ograničava zahtjeve. Sačekajte trenutak, pa pokušajte ponovo."],
  network: ["Server nije dostupan", "Nije moguće doći do servera. Provjerite vezu, pa pokušajte ponovo."],
  not_found: ["Nije pronađeno", "Ovo više ne postoji. Možda je obrisano."],
  conflict: ["Promijenjeno na drugom mjestu", "Ovo je prvo promijenjeno na drugom mjestu. Ponovo učitajte, pa pokušajte ponovo."],
  invalid: ["Zahtjev odbijen", "Server je odbio ovaj zahtjev kao nevažeći."],
  internal: ["Nešto nije u redu", "Došlo je do neočekivane greške. Pokušajte ponovo."],
  signIn: "Prijava",
  retry: "Pokušaj ponovo",
  reload: "Ponovo učitaj",
} satisfies ErrorMessages
