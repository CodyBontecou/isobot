/**
 * What a build sandbox may send out. The Container has no credentials: the Worker adds them here, and only
 * where they belong.
 *
 * - Claude Code holds a placeholder token. Requests to the Anthropic API get the real one.
 * - git reads the job's own repository from GitHub with the Worker's token. Pushes are refused
 *   (git-receive-pack, whoever's token): only the runner pushes, and only the commit it reviewed.
 * - Everything else goes out over HTTPS with no credentials: npm, pip and the web pages a content
 *   builder checks its claims against. That matches a local build, which also has the internet, and
 *   the Container holds nothing to leak but the repository it was given.
 * - Plain HTTP is refused, so nothing travels unencrypted.
 */

export const ANTHROPIC_HOST = "api.anthropic.com";

/** What Claude Code is started with; never valid anywhere. */
export const PLACEHOLDER_TOKEN = "sk-ant-oat01-isobot-sandbox-placeholder";

export interface OutboundContext {
  /** `owner/name` of the job's repository: the only one git may read with the Worker's token. */
  repo: string;
  claudeToken?: string;
  githubToken?: string;
}

export type OutboundDecision =
  | { action: "deny"; status: number; reason: string }
  | { action: "forward"; setHeaders: Record<string, string>; deleteHeaders: string[] };

const forward = (setHeaders: Record<string, string> = {}, deleteHeaders: string[] = []): OutboundDecision =>
  ({ action: "forward", setHeaders, deleteHeaders });
const deny = (status: number, reason: string): OutboundDecision => ({ action: "deny", status, reason });

/** git's smart-HTTP paths under github.com/<owner>/<repo>(.git)/. */
const GIT_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function decide(url: URL, ctx: OutboundContext): OutboundDecision {
  if (url.protocol !== "https:") return deny(403, `${url.hostname} is reachable only over HTTPS`);
  const host = url.hostname.toLowerCase();
  if (host === ANTHROPIC_HOST) {
    if (!ctx.claudeToken) return deny(503, "the sandbox Worker has no Claude Code token");
    // Whatever the Container sent is replaced, so its placeholder is never forwarded.
    return forward({ authorization: `Bearer ${ctx.claudeToken}` }, ["x-api-key"]);
  }
  if (host === "github.com") {
    const git = GIT_PATH.exec(url.pathname);
    if (git) {
      const service = git[3] === "info/refs" ? url.searchParams.get("service") : git[3];
      if (service === "git-receive-pack") return deny(403, "pushing from a build sandbox is not allowed; the runner pushes");
      if (service !== "git-upload-pack") return deny(403, "unknown git service");
      const ours = `${git[1]}/${git[2]}`.toLowerCase() === ctx.repo.toLowerCase();
      // Other repositories are fetched without credentials, so only public ones work.
      if (ours && ctx.githubToken) return forward({ authorization: `Basic ${btoa(`x-access-token:${ctx.githubToken}`)}` });
      return forward({}, ["authorization"]);
    }
  }
  // No credentials leave the Worker for any other host.
  return forward({}, ["authorization", "proxy-authorization", "cookie"]);
}
