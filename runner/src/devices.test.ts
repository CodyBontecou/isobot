import assert from "node:assert/strict";
import { test } from "node:test";
import { ANDROID_PORTS, emulatorSerials, freePort, LocalDevices, simulatorName, staleSimulators, type Exec } from "./devices.js";
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
