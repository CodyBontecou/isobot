import type { RepoPolicy } from "./config.js";
import type { Review } from "./builder.js";
import type { DiffStat } from "./git.js";

export interface CheckReport {
  configured: boolean;
  passed: boolean;
  results: { command: string; ok: boolean; output: string }[];
}

export interface GateInput {
  policy: RepoPolicy;
  diff: DiffStat;
  checks: CheckReport;
  review: Review;
  /** Labels on the issue at decision time (the owner can add the stop label at any point). */
  issueLabels: string[];
  stopLabel: string;
}

export interface GateDecision {
  merge: boolean;
  reasons: string[];
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|[^/]*Tests?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.swift$|Test\.kt$/;

/**
 * Deterministic merge gate. The model's opinion is one input; everything else is
 * checked here so a confident but wrong agent can't talk its way into main.
 */
export function evaluateGate(input: GateInput): GateDecision {
  const reasons: string[] = [];
  const { policy, diff, checks, review } = input;
  if (policy.autonomy !== "merge") reasons.push(`repository autonomy is "${policy.autonomy}" (human merges)`);
  if (input.issueLabels.some(label => label.toLowerCase() === input.stopLabel.toLowerCase())) reasons.push("the issue has the stop label");
  if (!checks.configured) reasons.push("no runner checks are configured for this repository");
  else if (!checks.passed) reasons.push("runner checks failed");
  if (review.verdict !== "approve") reasons.push("the reviewer requested changes");
  if (review.confidence < policy.minReviewConfidence) reasons.push(`reviewer confidence ${review.confidence.toFixed(2)} is below ${policy.minReviewConfidence}`);
  if (review.risk === "high") reasons.push("the reviewer rated the change high risk");
  if (diff.files.length === 0) reasons.push("the change is empty");
  if (diff.changedLines > policy.maxChangedLines) reasons.push(`${diff.changedLines} changed lines exceed the ${policy.maxChangedLines}-line limit`);
  const protectedHits = diff.files.filter(file => policy.protectedPaths.some(glob => matchesGlob(file.path, glob))).map(file => file.path);
  if (protectedHits.length) reasons.push(`touches protected paths: ${protectedHits.slice(0, 8).join(", ")}`);
  // Deleting test lines is how an agent "fixes" a failing test; additions are fine.
  const weakenedTests = diff.files.filter(file => TEST_FILE.test(file.path) && file.removed > file.added).map(file => file.path);
  if (weakenedTests.length) reasons.push(`removes more test lines than it adds: ${weakenedTests.slice(0, 5).join(", ")}`);
  return { merge: reasons.length === 0, reasons };
}

/** Minimal glob: `**` spans directories, `*` stays within one, `?` is one character. Case-insensitive. */
export function matchesGlob(file: string, glob: string): boolean {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      pattern += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`, "i").test(file);
}
