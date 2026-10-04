import { removeCredentials } from "../auth/token-store"

export async function logout() {
  await removeCredentials()
  console.log("Signed out")
}
