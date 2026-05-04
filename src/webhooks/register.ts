import "dotenv/config";
import { Octokit } from "@octokit/rest";
import reposJson from "../config/repos.json" with { type: "json" };

interface RepoTarget {
  owner: string;
  repo: string;
}

const EVENTS = ["issues", "issue_comment"];

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is required");
  const url = process.env.WEBHOOK_URL ?? "https://isobot.fly.dev/gh/webhook";

  const repos = dedupeRepos(Object.values(reposJson) as RepoTarget[]);
  const octokit = new Octokit({ auth: token, userAgent: "isobot/0.1" });

  for (const r of repos) {
    try {
      const { data: hooks } = await octokit.repos.listWebhooks({ owner: r.owner, repo: r.repo });
      const existing = hooks.find((h) => h.config?.url === url);
      const config = { url, content_type: "json" as const, secret, insecure_ssl: "0" };
      if (existing) {
        await octokit.repos.updateWebhook({
          owner: r.owner,
          repo: r.repo,
          hook_id: existing.id,
          config,
          events: EVENTS,
          active: true,
        });
        console.log(`[ok] ${r.owner}/${r.repo}: updated hook ${existing.id} -> ${url}`);
      } else {
        const { data } = await octokit.repos.createWebhook({
          owner: r.owner,
          repo: r.repo,
          config,
          events: EVENTS,
          active: true,
        });
        console.log(`[ok] ${r.owner}/${r.repo}: created hook ${data.id} -> ${url}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fail] ${r.owner}/${r.repo}: ${msg}`);
    }
  }
}

function dedupeRepos(rs: RepoTarget[]): RepoTarget[] {
  const seen = new Set<string>();
  const out: RepoTarget[] = [];
  for (const r of rs) {
    const k = `${r.owner}/${r.repo}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
