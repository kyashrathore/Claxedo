import type { CodeHostRepositoryAccess, CodeHostRepositoryListing } from "@/server"

export function shownRepositoryAccess(listing: CodeHostRepositoryListing | undefined, matchCount: number): CodeHostRepositoryAccess | undefined {
  if (!listing?.access) return undefined
  const privateListed = listing.repositories.some((repository) => repository.private)
  return matchCount === 0 || !privateListed ? listing.access : undefined
}
