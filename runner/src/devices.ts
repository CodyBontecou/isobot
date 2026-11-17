import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  /**
   * An existing AVD used as a template: each job gets its own copy of its configuration (same
   * system image and hardware, fresh data), deleted when the job ends. The template is never
   * booted or modified, so whatever else boots it can't get in a job's way.
   */
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
/** Per-job AVDs; anything with this prefix is isobot's to delete. */
export const JOB_AVD_PREFIX = "isobot-job-";
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

/**
 * A job's own AVD boots cold with fresh data (-wipe-data, -no-snapshot): nothing carries over between
 * jobs. gRPC (on 127.0.0.1, token-protected) is what argent's gestures drive; without it the emulator
 * also writes no discovery file, so argent can describe the screen but never tap.
 */
export function emulatorArgs(avd: string, port: number): string[] {
  return ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-wipe-data",
    "-port", String(port), "-grpc", String(port + GRPC_PORT_OFFSET), "-grpc-use-token"];
}

export function jobAvdName(jobId: string, port: number): string {
  return `${JOB_AVD_PREFIX}${jobId.replace(/[^\w-]/g, "-").slice(0, 60)}-${port}`;
}

/** 5600 → 8700: clear of the emulator's default gRPC ports (8554+). */
export const GRPC_PORT_OFFSET = 3100;

export function freePort(inUse: Set<number>): number | null {
  return ANDROID_PORTS.find(port => !inUse.has(port)) ?? null;
}

export class LocalDevices implements Devices {
  private ports = new Set<number>();
  private sdk: string;
  private avdHome: string;

  constructor(private logDir: string, private exec: Exec = defaultExec, env: NodeJS.ProcessEnv = process.env, private sleep = (ms: number) => new Promise(r => setTimeout(r, ms))) {
    this.sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? path.join(homedir(), "Library", "Android", "sdk");
    this.avdHome = env.ANDROID_AVD_HOME ?? path.join(env.ANDROID_USER_HOME ?? path.join(env.HOME ?? homedir(), ".android"), "avd");
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
        const { serial, stop } = await this.bootEmulator(jobId, spec.android.avd);
        releases.push(stop);
        env.ANDROID_SERIAL = serial;
        // Gradle needs the SDK too, and the runner's own environment usually doesn't name it.
        env.ANDROID_HOME = this.sdk;
        lines.push(`- Android emulator (a fresh copy of ${spec.android.avd}, yours alone): serial ${serial} (booted; adb and Gradle pick it up from $ANDROID_SERIAL in the isobot shell).`);
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

  /** A job's own AVD: the template's config.ini (system image, hardware) and nothing else. */
  private createJobAvd(template: string, name: string): () => void {
    const config = path.join(this.avdHome, `${template}.avd`, "config.ini");
    if (!existsSync(config)) throw new Error(`the template AVD ${template} doesn't exist (no ${config}); create it in Android Studio or with avdmanager`);
    const dir = path.join(this.avdHome, `${name}.avd`);
    const remove = () => { rmSync(dir, { recursive: true, force: true }); rmSync(path.join(this.avdHome, `${name}.ini`), { force: true }); };
    remove();
    mkdirSync(dir, { recursive: true });
    copyFileSync(config, path.join(dir, "config.ini"));
    const target = /^target=(.*)$/m.exec(readText(path.join(this.avdHome, `${template}.ini`)))?.[1];
    writeFileSync(path.join(this.avdHome, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${name}.avd\n${target ? `target=${target}\n` : ""}`);
    return remove;
  }

  private async bootEmulator(jobId: string, template: string): Promise<{ serial: string; stop: () => Promise<void> }> {
    await this.must(this.adb, ["start-server"], 60_000, "start adb");
    const running = emulatorSerials((await this.exec(this.adb, ["devices"], 30_000)).stdout).map(s => Number(s.slice("emulator-".length)));
    const port = freePort(new Set([...this.ports, ...running]));
    if (port === null) throw new TransientError("every isobot emulator port is in use");
    this.ports.add(port);
    const serial = `emulator-${port}`;
    const avd = jobAvdName(jobId, port);
    let removeAvd: () => void;
    try {
      removeAvd = this.createJobAvd(template, avd);
    } catch (error) {
      this.ports.delete(port);
      throw error;
    }
    mkdirSync(this.logDir, { recursive: true });
    const log = openSync(path.join(this.logDir, `${serial}.log`), "w");
    const child = spawn(this.emulator, emulatorArgs(avd, port), {
      detached: true, stdio: ["ignore", log, log],
    });
    closeSync(log);
    child.unref();
    const stop = async () => {
      await this.exec(this.adb, ["-s", serial, "emu", "kill"], 60_000);
      for (let i = 0; i < 20 && child.exitCode === null; i++) await this.sleep(500);
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
      removeAvd();
      this.ports.delete(port);
    };
    try {
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      for (;;) {
        if (child.exitCode !== null) {
          const logFile = path.join(this.logDir, `${serial}.log`);
          throw emulatorExitError(template, child.exitCode, readTail(logFile), logFile);
        }
        const prop = await this.exec(this.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], 30_000);
        if (prop.stdout.trim() === "1") break;
        if (Date.now() > deadline) throw new TransientError(`the Android emulator (${template}) didn't finish booting in ${BOOT_TIMEOUT_MS / 60_000} minutes`);
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
    // Job AVDs a crashed runner left behind (their emulators were just stopped).
    for (const entry of existsSync(this.avdHome) ? readdirSync(this.avdHome) : []) {
      if (entry.startsWith(JOB_AVD_PREFIX)) rmSync(path.join(this.avdHome, entry), { recursive: true, force: true });
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

/** How long to wait before trying again when someone else's emulator holds the AVD. */
export const LOCKED_AVD_RETRY_MS = 15 * 60_000;

/** How long to wait before trying again when the emulator finds too little free disk. */
export const LOW_DISK_RETRY_MS = 30 * 60_000;

/**
 * Why an emulator exited during boot. An AVD that another, writable emulator holds (one booted by
 * hand, Android Studio or another agent's argent session, without -read-only) is temporary: the job
 * waits for it rather than failing. Anything else is reported with the end of the emulator's log.
 */
export function emulatorExitError(avd: string, code: number, log: string, logFile: string): Error {
  if (/Another emulator instance is running/i.test(log)) {
    return new TransientError(
      `the AVD ${avd} is in use by an emulator isobot didn't start (booted without -read-only, e.g. by Android Studio or another agent's argent session). ` +
      `isobot retries in ${LOCKED_AVD_RETRY_MS / 60_000} minutes; shut that emulator down, or boot it with -read-only, to free it.`,
      LOCKED_AVD_RETRY_MS,
    );
  }
  if (/not have enough disk space/i.test(log)) {
    return new TransientError(
      `the Mac is out of disk space for the Android emulator (it needs room for the AVD's data partition). ` +
      `isobot retries in ${LOW_DISK_RETRY_MS / 60_000} minutes; free space (DerivedData, old simulators and AVDs) to unblock it. See ${logFile}`,
      LOW_DISK_RETRY_MS,
    );
  }
  const last = log.split("\n").map(line => line.trim()).filter(line => /ERROR|FATAL|PANIC/i.test(line)).slice(-3).join(" / ");
  return new Error(`the emulator exited with ${code}${last ? `: ${last.slice(0, 400)}` : ""}; see ${logFile}`);
}

function readText(file: string): string {
  try { return readTail(file, 64_000); } catch { return ""; }
}

function readTail(file: string, bytes = 16_384): string {
  try {
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

const defaultExec: Exec = (command, args, timeoutMs) => run(command, args, { cwd: homedir(), timeoutMs }).catch(error => ({
  code: 127, stdout: "", stderr: (error as Error).message, timedOut: false,
}));
