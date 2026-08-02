import { MarketplacePanel } from "../panel"

export function MarketplaceContent(props: { directory?: string; request?: typeof fetch }) {
  return <MarketplacePanel directory={props.directory} request={props.request} />
}
