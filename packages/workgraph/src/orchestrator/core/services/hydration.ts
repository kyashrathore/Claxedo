export interface NormalizedIssue {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed" | "in_progress";
  provider_url: string;
}

export interface ConnectorInterface {
  provider: string;
  hydrateIssue(params: Record<string, any>): Promise<NormalizedIssue>;
}

export interface FeatureSlice {
  featureId: string;
  issues: NormalizedIssue[];
  provider: string;
}

export async function hydrateFeatureSlice(
  connector: ConnectorInterface,
  featureId: string,
  issueParams: Record<string, any>[]
): Promise<FeatureSlice> {
  const issues = await Promise.all(
    issueParams.map(params => connector.hydrateIssue(params))
  );
  return { featureId, issues, provider: connector.provider };
}
