/**
 * Typed data carried by runner events (the `data` column of the events table), so tools can read a job's
 * history without parsing prose. Each type has a version `v`: change a shape by adding a new version, and keep
 * readers accepting the old ones, because the table keeps every event ever written.
 */
export type EventData =
  | { type: "state"; v: 1; from: string | null; to: string }
  | { type: "builder"; v: 1; round: string; ok: boolean }
  | { type: "checks"; v: 1; passed: boolean; failed: string[] }
  | { type: "review"; v: 1; round: number; verdict: "approve" | "request_changes"; confidence: number; risk: string }
  | { type: "pr"; v: 1; number: number; files: number; lines: number }
  | { type: "ci"; v: 1; state: string; waitedMinutes: number }
  | { type: "gate"; v: 1; merge: boolean; reasons: string[] }
  | { type: "blocked"; v: 1; on: string[] }
  | { type: "claim"; v: 1; runner: string; outcome: "won" | "lost" | "held_elsewhere"; holder?: string };

export type EventType = EventData["type"];

/** One line for a timeline, from an event's typed data, or its prose when it has none (older events). */
export function describeEvent(kind: string, detail: string | null, data: EventData | null): string {
  if (!data) return detail ? `${kind}: ${firstLine(detail)}` : kind;
  switch (data.type) {
    case "state": return `${data.from ?? "new"} → ${data.to}${detail ? ` (${firstLine(detail)})` : ""}`;
    case "builder": return `builder ${data.round}${data.ok ? "" : " (did not finish cleanly)"}`;
    case "checks": return data.passed ? "checks passed" : `checks failed: ${data.failed.join(", ") || "(unknown)"}`;
    case "review": return `review ${data.round}: ${data.verdict} · confidence ${data.confidence.toFixed(2)} · risk ${data.risk}`;
    case "pr": return `PR #${data.number} (${data.files} files, ${data.lines} lines)`;
    case "ci": return `CI ${data.state} after ${data.waitedMinutes} min`;
    case "gate": return data.merge ? "gate: merge" : `gate: left to you (${data.reasons.join("; ")})`;
    case "blocked": return `waiting on ${data.on.join(", ")}`;
    case "claim": return `claim ${data.outcome.replace("_", " ")} by ${data.runner}${data.holder ? ` (held by ${data.holder})` : ""}`;
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0].slice(0, 160);
}
