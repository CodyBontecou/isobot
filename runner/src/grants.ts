import { configuredRepos, contentPolicy, policyFor, type RepoPolicy, type RunnerConfig } from "./config.js";
import { UNPUSHABLE_PATHS } from "./pipeline.js";

export interface GrantsInput {
  config: RunnerConfig;
  /** The runner's GitHub account (the token's owner). */
  viewer: string;
  /** Discord user ids allowed to chat and use 💻, and where that list came from. */
  chatUsers: { ids: string[]; source: string };
  runnerId: string;
  /** Limit the per-repo part to one `owner/repo`. */
  repo?: string;
}

/**
 * `runner grants`: who may do what, gathered from the places it is decided (config, runner.env, policy.ts),
 * so you can check the setup without reading code. Read-only.
 */
export function explainGrants(input: GrantsInput): string {
  const { config, viewer } = input;
  const labels = config.labels;
  const trusted = [viewer, ...(config.trustedAuthors ?? [])].map(login => `@${login}`);
  const lines: string[] = [
    `isobot grants (runner \`${input.runnerId}\`)`,
    "",
    "Approve, stop, retry, clean up",
    `  ${trusted.join(", ")}: adding \`${labels.ready}\`, \`${labels.stop}\`, \`${labels.cleanup}\` or \`${labels.ship}\`, by hand or with ✅ 🛑 🔁 🧹 in Discord`,
    "  (the bridge turns a reaction into a label with your token, and only counts reactions from its ISOBOT_ALLOWED_USERS).",
    "  A ready or cleanup label from anyone else is removed with a comment.",
    "",
    "Merge without you",
    `  Only issues written by ${trusted.join(", ")}, or a stranger's issue rebuilt from isobot's own proposal that it auto-approved.`,
    `  Owner autonomy applies only when \`${labels.auto}\` was added by @${viewer}.`,
    "",
    "Notes to a build",
    `  Issue comments by ${trusted.join(", ")}; Discord thread replies count when the bridge relays them as one of those accounts.`,
    "",
    "Staff chat and 💻 handoff",
    `  ${input.chatUsers.ids.length ? `Discord users ${input.chatUsers.ids.join(", ")} (from ${input.chatUsers.source})` : input.chatUsers.source}.`,
    "",
    "Automatic approval",
  ];
  const auto = config.autoApprove;
  lines.push(auto?.sources.length
    ? `  ${auto.kinds.join("/")} proposals from ${auto.sources.join(", ")} at confidence ≥ ${auto.minConfidence}.`
    : "  Off for Discord, GitHub, email and App Store proposals.");
  if (config.vox) lines.push(`  Your Vox notes: ${config.vox.autoApprove ? `on, at confidence ≥ ${config.vox.minAutoApproveConfidence ?? 0.7}` : "off"}.`);
  lines.push(
    "",
    "Builders and checks",
    "  Builders get no GitHub, Pi, email or API credentials and write only to their workspace; checks run sandboxed with no keychain.",
    `  Never pushed: ${UNPUSHABLE_PATHS.join(", ")}.`,
    "",
    `Protected paths (any change to these is left to you): ${config.defaults.protectedPaths.join(", ") || "(none)"}`,
    "",
    "Per repository",
  );
  const repos = configuredRepos(config).filter(r => !input.repo || `${r.owner}/${r.repo}`.toLowerCase() === input.repo.toLowerCase());
  if (!repos.length) lines.push(input.repo ? `  ${input.repo} isn't configured: isobot never touches it.` : "  (none configured)");
  for (const { owner, repo } of repos) {
    const policy = policyFor(config, `${owner}/${repo}`);
    lines.push(`  ${owner}/${repo}`, ...repoLines(policy, labels.ship, config.defaults.protectedPaths).map(line => `    ${line}`));
    if (policy.content) {
      const content = contentPolicy(policy);
      lines.push(`    content train (${policy.content.site}): autonomy ${content.autonomy}, only ${content.allowedPaths?.join(", ") ?? "anywhere"}, CI ${content.requireCi ? "required" : "not required"}`);
    }
  }
  return lines.join("\n");
}

function repoLines(policy: RepoPolicy, shipLabel: string, defaults: string[]): string[] {
  const extra = policy.protectedPaths.filter(glob => !defaults.includes(glob));
  const autonomy = policy.ownerAutonomy && policy.ownerAutonomy !== policy.autonomy
    ? `autonomy ${policy.autonomy} (your own work: ${policy.ownerAutonomy})` : `autonomy ${policy.autonomy}`;
  return [
    `${autonomy}; a merge needs passing checks, review confidence ≥ ${policy.minReviewConfidence}, risk below high, no weakened tests${policy.requireCi ? ", green GitHub CI" : ""}${policy.checks.length ? "" : " (no checks configured, so it never merges)"}`,
    ...(extra.length ? [`also protected: ${extra.join(", ")}`] : []),
    ...(policy.release.onMerge.length ? [`after merge runs: ${policy.release.onMerge.join("; ")}`] : []),
    ...(policy.release.onShip.length ? [`after \`${shipLabel}\` runs: ${policy.release.onShip.join("; ")}`] : []),
  ];
}
