/**
 * GitHub REST API v3 client
 * Thin wrapper — no business logic, just auth + fetch.
 *
 * Adapted from devops-mcp/src/github/client.ts
 * Converted from module-level functions to class-based client.
 */

const GITHUB_API = 'https://api.github.com';

// ── Types ──────────────────────────────────────────────

export interface GitHubClientConfig {
  token: string;
  org?: string;
}

export interface RepoSummary {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  updated_at: string;
  html_url: string;
  topics: string[];
}

export interface PrSummary {
  number: number;
  title: string;
  state: string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  mergeable: boolean | null;
  created_at: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  head_branch: string;
}

interface FileContent {
  name: string;
  path: string;
  sha: string;
  content: string; // base64
  encoding: string;
  html_url: string;
}

// ── Client ─────────────────────────────────────────────

export class GitHubClient {
  private readonly token: string;
  private readonly org: string | undefined;

  constructor(config: GitHubClientConfig) {
    this.token = config.token;
    this.org = config.org;
  }

  /** Require org to be set — throws if constructor didn't receive one. */
  private requireOrg(): string {
    if (!this.org) {
      throw new Error('GitHubClient: org is required for this operation. Pass { org } in constructor.');
    }
    return this.org;
  }

  private async ghFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(opts.headers as Record<string, string> | undefined),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub ${res.status}: ${body}`);
    }

    // 204 No Content (e.g., merge)
    if (res.status === 204) return {} as T;

    return res.json() as Promise<T>;
  }

  // ── Repos ──────────────────────────────────────────

  async listRepos(opts?: { sort?: string; per_page?: number }): Promise<RepoSummary[]> {
    const org = this.requireOrg();
    const sort = opts?.sort ?? 'updated';
    const perPage = opts?.per_page ?? 30;
    return this.ghFetch<RepoSummary[]>(
      `/orgs/${org}/repos?sort=${sort}&per_page=${perPage}&type=all`
    );
  }

  // ── Files ──────────────────────────────────────────

  async getFile(
    repo: string,
    path: string,
    ref?: string
  ): Promise<{ content: string; sha: string }> {
    const org = this.requireOrg();
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const data = await this.ghFetch<FileContent>(
      `/repos/${org}/${repo}/contents/${encodeURIComponent(path)}${q}`
    );
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content, sha: data.sha };
  }

  async putFile(
    repo: string,
    path: string,
    content: string,
    message: string,
    branch: string,
    sha?: string
  ): Promise<{ sha: string; html_url: string }> {
    const org = this.requireOrg();
    const body: Record<string, string> = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
    };
    if (sha) body.sha = sha;

    const data = await this.ghFetch<{ content: { sha: string; html_url: string } }>(
      `/repos/${org}/${repo}/contents/${encodeURIComponent(path)}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );
    return { sha: data.content.sha, html_url: data.content.html_url };
  }

  // ── Branches ───────────────────────────────────────

  async createBranch(
    repo: string,
    branchName: string,
    fromRef?: string
  ): Promise<{ ref: string }> {
    const org = this.requireOrg();
    // Get SHA of source ref
    const ref = fromRef ?? 'heads/main';
    const source = await this.ghFetch<{ object: { sha: string } }>(
      `/repos/${org}/${repo}/git/ref/${ref}`
    );

    return this.ghFetch<{ ref: string }>(
      `/repos/${org}/${repo}/git/refs`,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${branchName}`,
          sha: source.object.sha,
        }),
      }
    );
  }

  // ── Pull Requests ──────────────────────────────────

  async createPr(
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string
  ): Promise<PrSummary> {
    const org = this.requireOrg();
    return this.ghFetch<PrSummary>(
      `/repos/${org}/${repo}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({ title, head, base, body: body ?? '' }),
      }
    );
  }

  async mergePr(
    repo: string,
    pullNumber: number,
    mergeMethod?: 'merge' | 'squash' | 'rebase'
  ): Promise<{ merged: boolean; message: string }> {
    const org = this.requireOrg();
    return this.ghFetch<{ merged: boolean; message: string }>(
      `/repos/${org}/${repo}/pulls/${pullNumber}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify({ merge_method: mergeMethod ?? 'squash' }),
      }
    );
  }

  async listPrs(
    repo: string,
    state?: 'open' | 'closed' | 'all'
  ): Promise<PrSummary[]> {
    const org = this.requireOrg();
    return this.ghFetch<PrSummary[]>(
      `/repos/${org}/${repo}/pulls?state=${state ?? 'open'}&per_page=20`
    );
  }

  // ── GitHub Actions ─────────────────────────────────

  async triggerWorkflow(
    repo: string,
    workflowId: string,
    ref: string,
    inputs?: Record<string, string>
  ): Promise<void> {
    const org = this.requireOrg();
    await this.ghFetch<void>(
      `/repos/${org}/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        method: 'POST',
        body: JSON.stringify({ ref, inputs: inputs ?? {} }),
      }
    );
  }

  async getWorkflowRuns(
    repo: string,
    opts?: { workflow_id?: string; branch?: string; per_page?: number }
  ): Promise<WorkflowRun[]> {
    const org = this.requireOrg();
    const params = new URLSearchParams();
    if (opts?.branch) params.set('branch', opts.branch);
    params.set('per_page', String(opts?.per_page ?? 10));

    const path = opts?.workflow_id
      ? `/repos/${org}/${repo}/actions/workflows/${opts.workflow_id}/runs`
      : `/repos/${org}/${repo}/actions/runs`;

    const data = await this.ghFetch<{ workflow_runs: WorkflowRun[] }>(
      `${path}?${params.toString()}`
    );
    return data.workflow_runs;
  }
}
