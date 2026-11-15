import { run, sh, tail, workerEnv } from "./proc.js";
import type { CheckReport } from "./policy.js";
import { sandboxed } from "./sandbox.js";

export interface CheckOptions {
  timeoutMs?: number;
  /** Seatbelt profile: set for builder-written code (checks); unset for release commands on merged code. */
  sandboxProfile?: string;
  /** Directory of tool wrappers (shims.ts) prepended to PATH for sandboxed runs. */
  shimDir?: string;
}

/** Runs commands in `cwd` in order, stopping at the first failure. */
export async function runChecks(cwd: string, commands: string[], options: CheckOptions = {}): Promise<CheckReport> {
  const results: CheckReport["results"] = [];
  const timeoutMs = options.timeoutMs ?? 45 * 60_000;
  for (const command of commands) {
    const env = options.sandboxProfile && options.shimDir ? workerEnv({ PATH: `${options.shimDir}:${process.env.PATH ?? ""}` }) : workerEnv();
    const result = options.sandboxProfile
      ? await run(...sandboxed(command, options.sandboxProfile), { cwd, env, timeoutMs })
      : await sh(command, { cwd, env: workerEnv(), timeoutMs });
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
