import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { TransientError } from "./errors.js";
import { run, type RunResult } from "./proc.js";

/**
 * Per-job test devices. The builder's own shell can't reach CoreSimulator or bind adb's port,
 * so the runner (outside every sandbox) creates and boots a device for each job, hands its id
 * to checks and to the builder's isobot shell tool, and throws it away when the job ends.
 */
export interface DeviceSpec {
  /** A fresh simulator of this type, e.g. "iPhone 17". `runtime` defaults to the newest installed iOS. */
  ios?: { deviceType: string; runtime?: string };
  /** A throwaway (read-only) instance of an existing AVD; the AVD itself is never modified. */
  android?: { avd: string };
}

export interface DeviceLease {
  /** ISOBOT_IOS_SIMULATOR (a UDID), ANDROID_SERIAL and ANDROID_HOME, for checks and the builder's isobot shell. */
  env: Record<string, string>;
  /** Shown to the builder: which devices are its own and how to reach them. */
  describe(): string;
  release(): Promise<void>;
}

export interface Devices {
  lease(jobId: string, spec: DeviceSpec): Promise<DeviceLease>;
  /** At startup, before any job runs: removes devices a crashed runner left behind. */
  cleanupStale(): Promise<void>;
}

export type Exec = (command: string, args: string[], timeoutMs?: number) => Promise<RunResult>;

export const SIMULATOR_PREFIX = "isobot-";
/** Emulator console ports isobot uses; outside the default 5554-5584 range so your own emulators never collide. */
export const ANDROID_PORTS = Array.from({ length: 16 }, (_, i) => 5600 + i * 2);

const BOOT_TIMEOUT_MS = 10 * 60_000;

export function hasDevices(spec: DeviceSpec | undefined): spec is DeviceSpec {
  return Boolean(spec && (spec.ios || spec.android));
}

export function simulatorName(jobId: string): string {
  return `${SIMULATOR_PREFIX}${jobId}`.replace(/[^\w.-]/g, "-").slice(0, 80);
}

/** UDIDs of simulators named isobot-*, from `simctl list devices -j`. */
export function staleSimulators(listJson: string): string[] {
  const parsed = JSON.parse(listJson) as { devices?: Record<string, { name: string; udid: string }[]> };
  return Object.values(parsed.devices ?? {}).flat().filter(d => d.name.startsWith(SIMULATOR_PREFIX)).map(d => d.udid);
}

/** Running emulator serials from `adb devices`. */
export function emulatorSerials(adbDevices: string): string[] {
  return adbDevices.split("\n").map(line => line.trim().split(/\s+/)[0]).filter(serial => /^emulator-\d+$/.test(serial));
}

export function freePort(inUse: Set<number>): number | null {
  return ANDROID_PORTS.find(port => !inUse.has(port)) ?? null;
}

export class LocalDevices implements Devices {
  private ports = new Set<number>();
  private sdk: string;

  constructor(private logDir: string, private exec: Exec = defaultExec, env: NodeJS.ProcessEnv = process.env, private sleep = (ms: number) => new Promise(r => setTimeout(r, ms))) {
    this.sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? path.join(homedir(), "Library", "Android", "sdk");
  }

  private get adb(): string { return path.join(this.sdk, "platform-tools", "adb"); }
  private get emulator(): string { return path.join(this.sdk, "emulator", "emulator"); }

  async lease(jobId: string, spec: DeviceSpec): Promise<DeviceLease> {
    const env: Record<string, string> = {};
    const lines: string[] = [];
    const releases: (() => Promise<void>)[] = [];
    const release = async () => { for (const undo of releases.reverse()) await undo().catch(() => undefined); };
    try {
      if (spec.ios) {
        const udid = await this.bootSimulator(simulatorName(jobId), spec.ios);
        releases.push(() => this.deleteSimulator(udid));
        env.ISOBOT_IOS_SIMULATOR = udid;
        lines.push(`- iOS simulator ${spec.ios.deviceType}: UDID ${udid} (booted; in the isobot shell it's $ISOBOT_IOS_SIMULATOR, e.g. \`xcodebuild test -destination "id=$ISOBOT_IOS_SIMULATOR"\`).`);
      }
      if (spec.android) {
        const { serial, stop } = await this.bootEmulator(spec.android.avd);
        releases.push(stop);
        env.ANDROID_SERIAL = serial;
        // Gradle needs the SDK too, and the runner's own environment usually doesn't name it.
        env.ANDROID_HOME = this.sdk;
        lines.push(`- Android emulator (${spec.android.avd}, read-only): serial ${serial} (booted; adb and Gradle pick it up from $ANDROID_SERIAL in the isobot shell).`);
      }
    } catch (error) {
      await release();
      throw error;
    }
    return { env, describe: () => lines.join("\n"), release };
  }

  private async bootSimulator(name: string, ios: NonNullable<DeviceSpec["ios"]>): Promise<string> {
    const created = await this.must("xcrun", ["simctl", "create", name, ios.deviceType, ...(ios.runtime ? [ios.runtime] : [])], 120_000, "create the iOS simulator");
    const udid = created.stdout.trim().split("\n").at(-1)!.trim();
    if (!/^[0-9A-F-]{36}$/i.test(udid)) throw new Error(`simctl create printed no UDID: ${created.stdout.slice(0, 200)}`);
    try {
      await this.must("xcrun", ["simctl", "bootstatus", udid, "-b"], BOOT_TIMEOUT_MS, "boot the iOS simulator");
    } catch (error) {
      await this.deleteSimulator(udid);
      throw error;
    }
    return udid;
  }

  private async deleteSimulator(udid: string): Promise<void> {
    await this.exec("xcrun", ["simctl", "shutdown", udid], 120_000);
    await this.exec("xcrun", ["simctl", "delete", udid], 120_000);
  }

  private async bootEmulator(avd: string): Promise<{ serial: string; stop: () => Promise<void> }> {
    await this.must(this.adb, ["start-server"], 60_000, "start adb");
    const running = emulatorSerials((await this.exec(this.adb, ["devices"], 30_000)).stdout).map(s => Number(s.slice("emulator-".length)));
    const port = freePort(new Set([...this.ports, ...running]));
    if (port === null) throw new TransientError("every isobot emulator port is in use");
    this.ports.add(port);
    const serial = `emulator-${port}`;
    mkdirSync(this.logDir, { recursive: true });
    const log = openSync(path.join(this.logDir, `${serial}.log`), "w");
    // -read-only lets several instances share one AVD and leaves it untouched; nothing is saved on exit.
    const child = spawn(this.emulator, ["-avd", avd, "-read-only", "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save", "-port", String(port)], {
      detached: true, stdio: ["ignore", log, log],
    });
    closeSync(log);
    child.unref();
    const stop = async () => {
      await this.exec(this.adb, ["-s", serial, "emu", "kill"], 60_000);
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
      this.ports.delete(port);
    };
    try {
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      for (;;) {
        if (child.exitCode !== null) throw new Error(`the emulator exited with ${child.exitCode}; see ${path.join(this.logDir, `${serial}.log`)}`);
        const prop = await this.exec(this.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], 30_000);
        if (prop.stdout.trim() === "1") break;
        if (Date.now() > deadline) throw new TransientError(`the Android emulator ${avd} didn't finish booting in ${BOOT_TIMEOUT_MS / 60_000} minutes`);
        await this.sleep(3000);
      }
    } catch (error) {
      await stop();
      throw error;
    }
    return { serial, stop };
  }

  async cleanupStale(): Promise<void> {
    const list = await this.exec("xcrun", ["simctl", "list", "devices", "-j"], 120_000);
    if (list.code === 0) for (const udid of staleSimulators(list.stdout)) await this.deleteSimulator(udid);
    const adb = await this.exec(this.adb, ["devices"], 30_000).catch(() => null);
    for (const serial of emulatorSerials(adb?.stdout ?? "")) {
      if (ANDROID_PORTS.includes(Number(serial.slice("emulator-".length)))) await this.exec(this.adb, ["-s", serial, "emu", "kill"], 60_000);
    }
  }

  private async must(command: string, args: string[], timeoutMs: number, what: string): Promise<RunResult> {
    const result = await this.exec(command, args, timeoutMs);
    if (result.code !== 0 || result.timedOut) {
      throw new TransientError(`couldn't ${what}: ${(result.stderr || result.stdout).trim().slice(-500) || (result.timedOut ? "timed out" : `exit ${result.code}`)}`);
    }
    return result;
  }
}

const defaultExec: Exec = (command, args, timeoutMs) => run(command, args, { cwd: homedir(), timeoutMs }).catch(error => ({
  code: 127, stdout: "", stderr: (error as Error).message, timedOut: false,
}));
