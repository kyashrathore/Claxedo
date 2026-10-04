import { lazyView } from "@/lib/lazy-view"

export const MarketplacePage = lazyView(() => import("./view/marketplace-page").then((module) => module.MarketplacePage))
