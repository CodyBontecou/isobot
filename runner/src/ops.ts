import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Keeps the Mac from idle-sleeping while builds run (a laptop lid or display sleep would stall them). */
export class Awake {
  private child: ChildProcess | null = null;

  update(busy: boolean): void {
    if (busy && !this.child) {
      // -i: prevent idle sleep; -w: exit when the runner exits, even if it crashes.
      this.child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      this.child.on("error", () => { this.child = null; });
      this.child.on("exit", () => { this.child = null; });
    } else if (!busy && this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

/**
 * Rotates a log that launchd appends to. launchd keeps the file open, so it is
 * copied and truncated in place rather than renamed.
 */
export function rotateLog(file: string, maxBytes = 10 * 1024 * 1024, keep = 3): boolean {
  if (!existsSync(file) || statSync(file).size < maxBytes) return false;
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
  }
  copyFileSync(file, `${file}.1`);
  truncateSync(file, 0);
  rmSync(`${file}.${keep + 1}`, { force: true });
  return true;
}

export interface Heartbeat {
  at: string;
  pid: number;
  activeJobs: string[];
  queued: number;
  buildsPausedUntil: string | null;
  manuallyPaused: boolean;
  lastTriageAt: string | null;
  lastCycleError: string | null;
}

export function writeHeartbeat(home: string, beat: Heartbeat): void {
  const file = path.join(home, "heartbeat.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(beat, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function readHeartbeat(home: string): Heartbeat | null {
  try { return JSON.parse(readFileSync(path.join(home, "heartbeat.json"), "utf8")) as Heartbeat; } catch { return null; }
}

/** Whether a heartbeat is recent enough to believe the runner is alive and cycling. */
/**
 * Pings an external dead-man's switch (healthchecks.io, Better Stack, Cronitor…). Only healthy
 * cycles ping, so a runner that is down, asleep, offline or failing every cycle all look the same
 * from outside: the pings stop and that service alerts. Never throws.
 */
export async function pingHeartbeat(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export function heartbeatAge(beat: Heartbeat | null, now = Date.now()): number | null {
  return beat ? now - Date.parse(beat.at) : null;
}
