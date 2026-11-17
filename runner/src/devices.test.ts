import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ANDROID_PORTS, emulatorArgs, emulatorExitError, emulatorSerials, freePort, LocalDevices, LOCKED_AVD_RETRY_MS, simulatorName, staleSimulators, type Exec } from "./devices.js";
import { TransientError } from "./errors.js";
import type { RunResult } from "./proc.js";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const UDID = "11111111-2222-3333-4444-555555555555";

test("simulator names are prefixed and safe for simctl", () => {
  assert.equal(simulatorName("codybontecou/health-md#329"), "isobot-codybontecou-health-md-329");
});

test("stale cleanup only targets isobot-named simulators and isobot emulator ports", () => {
  const list = JSON.stringify({ devices: { "iOS-27": [{ name: "isobot-x#1", udid: "A" }, { name: "VoxQuote-QA", udid: "B" }] } });
  assert.deepEqual(staleSimulators(list), ["A"]);
  assert.deepEqual(emulatorSerials("List of devices attached\nemulator-5554\tdevice\nemulator-5600\tdevice\nR58M\tdevice\n"), ["emulator-5554", "emulator-5600"]);
  assert.equal(freePort(new Set([5600, 5602])), 5604);
  assert.equal(freePort(new Set(ANDROID_PORTS)), null);
});

test("an iOS lease creates and boots a fresh simulator, and release deletes it", async () => {
  const calls: string[] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return args[1] === "create" ? ok(`${UDID}\n`) : ok();
  };
  const lease = await new LocalDevices("/tmp/isobot-test-devices", exec).lease("o/r#1", { ios: { deviceType: "iPhone 17" } });
  assert.deepEqual(lease.env, { ISOBOT_IOS_SIMULATOR: UDID });
  assert.match(lease.describe(), new RegExp(UDID));
  await lease.release();
  assert.deepEqual(calls, [
    "xcrun simctl create isobot-o-r-1 iPhone 17",
    `xcrun simctl bootstatus ${UDID} -b`,
    `xcrun simctl shutdown ${UDID}`,
    `xcrun simctl delete ${UDID}`,
  ]);
});

test("a simulator that fails to boot is deleted and reported as transient", async () => {
  const calls: string[] = [];
  const exec: Exec = async (command, args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (args[1] === "create") return ok(UDID);
    if (args[1] === "bootstatus") return { code: 1, stdout: "", stderr: "Unable to boot", timedOut: false };
    return ok();
  };
  await assert.rejects(new LocalDevices("/tmp/x", exec).lease("o/r#2", { ios: { deviceType: "iPhone 17" } }), (error: Error) => {
    assert.equal(error.constructor.name, "TransientError");
    assert.match(error.message, /Unable to boot/);
    return true;
  });
  assert.ok(calls.includes("simctl delete"));
});

test("emulators are read-only and expose token-protected gRPC for argent", () => {
  const args = emulatorArgs("isobot-api35", 5602);
  assert.deepEqual(args.slice(0, 3), ["-avd", "isobot-api35", "-read-only"]);
  assert.equal(args[args.indexOf("-port") + 1], "5602");
  assert.equal(args[args.indexOf("-grpc") + 1], "8702");
  assert.ok(args.includes("-grpc-use-token"));
});

test("an AVD held by someone else's writable emulator is waited out, not blamed on the job", async () => {
  const sdk = mkdtempSync(path.join(tmpdir(), "isobot-sdk-"));
  mkdirSync(path.join(sdk, "emulator"));
  // What the real emulator prints when a writable instance (e.g. an argent boot) holds the AVD.
  writeFileSync(path.join(sdk, "emulator", "emulator"), "#!/bin/sh\necho 'WARNING | Another emulator is still running, wait for a sec...'\necho 'ERROR | Another emulator instance is running. Please close it or run all emulators with -read-only flag.'\nexit 1\n");
  chmodSync(path.join(sdk, "emulator", "emulator"), 0o755);
  const exec: Exec = async () => ok("List of devices attached\n");
  const devices = new LocalDevices(path.join(sdk, "logs"), exec, { ANDROID_HOME: sdk }, () => new Promise(r => setTimeout(r, 50)));
  await assert.rejects(devices.lease("o/r#3", { android: { avd: "isobot-api35" } }), (error: Error) => {
    assert.ok(error instanceof TransientError);
    assert.equal(error.retryAfterMs, LOCKED_AVD_RETRY_MS);
    assert.match(error.message, /isobot-api35 is in use by an emulator isobot didn't start/);
    return true;
  });
});

test("other emulator exits name the error from its log", () => {
  const error = emulatorExitError("a", 1, "INFO | starting\nERROR | x86 emulation currently requires hardware acceleration\n", "/l.log");
  assert.ok(!(error instanceof TransientError));
  assert.match(error.message, /exited with 1: ERROR \| x86 emulation currently requires hardware acceleration; see \/l.log/);
});
