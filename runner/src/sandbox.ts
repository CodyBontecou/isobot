import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { defaultBuildCaches, defaultDenyPaths } from "./builder.js";

/**
 * macOS Seatbelt profile for commands the runner executes on builder-written code
 * (checks such as `npm test`). The builder controls those scripts, so they get the
 * same limits as the builder's own shell: no keychain, no credential folders or
 * runner secrets, and writes only to the workspace, temp and toolchain caches.
 */
export interface SandboxPaths {
  workspace: string;
  /** Extra files or folders that must not be read (runner.env, state…). */
  secrets: string[];
  /** Extra writable locations (from builder.settings.sandbox.filesystem.allowWrite). */
  allowWrite?: string[];
}

/** Keychain and credential-agent services; denying them blocks `security find-*-password` and friends. */
const KEYCHAIN_SERVICES = [
  "com.apple.SecurityServer", "com.apple.securityd.xpc", "com.apple.security.agent",
  "com.apple.secd", "com.apple.security.keychain-circle-notification", "com.apple.CoreAuthentication.daemon",
];

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

/** Seatbelt matches resolved paths (/private/var…, not /var…). */
function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function sandboxProfile(paths: SandboxPaths, home = homedir()): string {
  const denyRead = [...defaultDenyPaths(home), ...paths.secrets];
  const writable = [
    paths.workspace, tmpdir(), "/private/tmp", "/private/var/folders", "/dev",
    ...defaultBuildCaches(home), ...(paths.allowWrite ?? []),
  ];
  return [
    "(version 1)",
    "(allow default)",
    `(deny mach-lookup ${KEYCHAIN_SERVICES.map(name => `(global-name ${quote(name)})`).join(" ")})`,
    `(deny file-read* ${denyRead.flatMap(p => [`(subpath ${quote(p)})`, `(subpath ${quote(real(p))})`]).join(" ")})`,
    "(deny file-write*)",
    `(allow file-write* ${[...new Set(writable.flatMap(p => [p, real(p)]))].map(p => `(subpath ${quote(p)})`).join(" ")})`,
  ].join("\n");
}

/** argv that runs `commandLine` under the profile. */
export function sandboxed(commandLine: string, profile: string): [string, string[]] {
  return ["/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", commandLine]];
}
