import { sh, tail, workerEnv } from "./proc.js";
import type { CheckReport } from "./policy.js";

/** Runs the repository's configured checks in the worktree. Stops at the first failure. */
export async function runChecks(cwd: string, commands: string[], timeoutMs = 45 * 60_000): Promise<CheckReport> {
  const results: CheckReport["results"] = [];
  for (const command of commands) {
    const result = await sh(command, { cwd, env: workerEnv(), timeoutMs });
    const ok = result.code === 0 && !result.timedOut;
    const output = tail(`${result.stdout}\n${result.stderr}`.trim(), 6000);
    results.push({ command, ok, output: result.timedOut ? `Timed out.\n${output}` : output });
    if (!ok) break;
  }
  return { configured: commands.length > 0, passed: results.every(r => r.ok), results };
}

export function formatChecks(report: CheckReport): string {
  if (!report.configured) return "No runner checks are configured for this repository; the builder ran its own verification.";
  return report.results.map(r => `- ${r.ok ? "✅" : "❌"} \`${r.command}\`${r.ok ? "" : `\n\n\`\`\`\n${r.output}\n\`\`\``}`).join("\n");
}

export function failureFeedback(report: CheckReport): string {
  const failed = report.results.find(r => !r.ok);
  if (!failed) return "";
  return `The runner's check \`${failed.command}\` failed:\n\n\`\`\`\n${failed.output}\n\`\`\``;
}
