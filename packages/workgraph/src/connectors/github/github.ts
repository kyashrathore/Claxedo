import type { Octokit } from "@octokit/rest";

export interface NormalizedIssue {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed" | "in_progress";
  provider_url: string;
}

export class GitHubConnector {
  private octokit: Octokit;

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  async hydrateIssue(owner: string, repo: string, issueNumber: number): Promise<NormalizedIssue> {
    const response = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    const data = response.data;

    return {
      id: data.number.toString(),
      title: data.title,
      description: data.body || "",
      // Map github states to our internal narrow type
      status: data.state === "open" ? "open" : "closed",
      provider_url: data.html_url,
    };
  }

  async updateIssue(owner: string, repo: string, issueNumber: number, updates: { title?: string; state?: "open" | "closed"; body?: string }): Promise<void> {
    await this.octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, ...updates });
  }

  async addComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }

  async createIssue(owner: string, repo: string, data: { title: string; body: string }): Promise<NormalizedIssue> {
    const response = await this.octokit.rest.issues.create({ owner, repo, ...data });
    const d = response.data;
    return {
      id: d.number.toString(),
      title: d.title,
      description: d.body || "",
      status: d.state === "open" ? "open" : "closed",
      provider_url: d.html_url,
    };
  }
}
