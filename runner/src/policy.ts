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
  /** Some reason is the owner's doing (stop label, a note, an edit, a closed issue): theirs to settle, never dropped. */
  ownerHold?: boolean;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|[^/]*Tests?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.swift$|Test\.kt$/;

/** Why the review alone keeps a change out of main. The builder gets another round for each of these. */
export function reviewShortfalls(review: Review, policy: Pick<RepoPolicy, "minReviewConfidence">): string[] {
  const reasons: string[] = [];
  if (review.verdict !== "approve") reasons.push("the reviewer requested changes");
  if (review.confidence < policy.minReviewConfidence) reasons.push(`reviewer confidence ${review.confidence.toFixed(2)} is below ${policy.minReviewConfidence}`);
  if (review.risk === "high") reasons.push("the reviewer rated the change high risk");
  return reasons;
}

/** How much an approval's confidence must rise over two review rounds to be worth a third. */
export const MIN_REVIEW_GAIN = 0.03;

/**
 * Why another review round wouldn't help, or null when it might. Called only when the review asks for one.
 * `confidences` is every review's confidence for this build, oldest first, the current one last.
 */
export function reviewStopReason(review: Review, confidences: number[]): string | null {
  const blockers = review.blockers ?? [];
  if (review.concerns.length === 0 && blockers.length > 0) {
    return "every remaining concern needs you, not more code";
  }
  if (review.verdict === "approve" && confidences.length >= 3) {
    const recent = confidences.slice(-3);
    if (recent[2] - recent[0] < MIN_REVIEW_GAIN) {
      return `reviewer confidence stopped improving (${recent.map(c => c.toFixed(2)).join(" → ")})`;
    }
  }
  return null;
}

/** Changed files the policy keeps out of an automatic merge: protected ones, and ones outside `allowedPaths`. */
export function strayPaths(policy: Pick<RepoPolicy, "protectedPaths" | "allowedPaths">, diff: Pick<DiffStat, "files">): { protected: string[]; outside: string[] } {
  const allowed = policy.allowedPaths;
  return {
    protected: diff.files.filter(file => policy.protectedPaths.some(glob => matchesGlob(file.path, glob))).map(file => file.path),
    outside: allowed ? diff.files.filter(file => !allowed.some(glob => matchesGlob(file.path, glob))).map(file => file.path) : [],
  };
}

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
  reasons.push(...reviewShortfalls(review, policy));
  if (diff.files.length === 0) reasons.push("the change is empty");
  const stray = strayPaths(policy, diff);
  if (stray.protected.length) reasons.push(`touches protected paths: ${stray.protected.slice(0, 8).join(", ")}`);
  if (stray.outside.length) reasons.push(`changes files outside the allowed paths: ${stray.outside.slice(0, 8).join(", ")}`);
  // Deleting test lines is how an agent "fixes" a failing test; additions are fine.
  const weakenedTests = diff.files.filter(file => TEST_FILE.test(file.path) && file.removed > file.added).map(file => file.path);
  if (weakenedTests.length) reasons.push(`removes more test lines than it adds: ${weakenedTests.slice(0, 5).join(", ")}`);
  // A same-size edit can still switch tests off; any new skip/ignore/focus marker leaves the merge to a human.
  const skips = diff.skipMarkers ?? [];
  if (skips.length) reasons.push(`disables or narrows tests: ${skips.slice(0, 5).map(s => `${s.marker} in ${s.path}`).join(", ")}`);
  return { merge: reasons.length === 0, reasons };
}

/**
 * Ways to switch a test off (or, with "only"/"fit", to run just some) across the stacks isobot builds.
 * Matched on any file, not just test files, because xcodebuild flags and test-runner arguments live
 * in scripts and Makefiles. False positives only mean a human merges.
 */
const JS_FILE = /\.[cm]?[jt]sx?$/i;
const SKIP_PATTERNS: [string, RegExp, RegExp?][] = [
  ["skip/only/todo", /\b(?:it|test|describe|context|suite|bench)\s*\.\s*(?:skip|only|todo|skipIf|runIf)\b/],
  // JavaScript-only spellings: `fit(` or `skip: true` mean something else in Swift or Kotlin.
  ["xit/fit", /(?<![\w.])[xf](?:it|describe|test|context)\s*\(/, JS_FILE],
  ["skip option", /\b(?:skip|todo)\s*:\s*(?:true|["'`])/, JS_FILE],
  ["XCTSkip", /\bXCTSkip(?:If|Unless)?\b/],
  // Swift Testing traits only; SwiftUI's `.disabled(isLoading)` modifier is everywhere.
  [".disabled", /@(?:Test|Suite)\s*\(.*\.(?:disabled|enabled\s*\(\s*if)\b/],
  ["-skip-testing", /-skip-testing\b|-skip-test-configuration\b|-only-testing\b/],
  ["@Ignore/@Disabled", /@(?:Ignore|Disabled|DisabledIf\w*)\b/],
  ["Python skip", /\b(?:unittest\.skip\w*|pytest\.mark\.(?:skip\w*|xfail)|pytest\.skip|skipTest)\b/],
  ["#[ignore]", /#\s*\[\s*ignore\b/],
  ["t.Skip", /\bt\.Skip(?:Now|f)?\s*\(/],
  ["test filter", /--(?:testPathIgnorePatterns|exclude-task)\b|\s-x\s+test\b|\bcargo\s+test\b.*\s--skip\b/],
];

/** Prose mentions `-skip-testing` and friends without running anything. */
const DOC_FILE = /\.(?:md|markdown|txt|rst|adoc|html?)$|(?:^|\/)docs?\//i;

/**
 * Markers a unified diff adds on net, per file: occurrences on "+" lines minus those on "-" lines,
 * so moving an existing skip around doesn't count, but adding one does. Only files that already
 * existed count: a skip in a brand-new file switches off nothing that ran before.
 */
export function skipMarkers(patch: string): { path: string; marker: string }[] {
  const counts = new Map<string, number>();
  let file = "";
  let header = false;
  let created = false;
  for (const line of patch.split("\n")) {
    // File headers sit between "diff --git" and the first hunk; inside hunks "---"/"+++" are content.
    if (line.startsWith("diff --git ")) { header = true; file = ""; created = false; continue; }
    if (header) {
      if (line.startsWith("@@")) header = false;
      else if (line.startsWith("new file mode") || line === "--- /dev/null") created = true;
      else if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "");
      else if (line.startsWith("--- ") && !file) file = line.slice(4).replace(/^a\//, "");
      if (file === "/dev/null") file = "";
      continue;
    }
    const sign = line[0] === "+" ? 1 : line[0] === "-" ? -1 : 0;
    if (!sign || !file || created || DOC_FILE.test(file)) continue;
    for (const [name, pattern, only] of SKIP_PATTERNS) {
      if ((only && !only.test(file)) || !pattern.test(line.slice(1))) continue;
      const key = `${file}\0${name}`;
      counts.set(key, (counts.get(key) ?? 0) + sign);
    }
  }
  return [...counts].filter(([, n]) => n > 0).map(([key]) => { const [path, marker] = key.split("\0"); return { path, marker }; });
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
