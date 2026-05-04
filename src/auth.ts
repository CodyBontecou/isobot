import type { Client } from "discord.js";
import { Team } from "discord.js";

let allowed: Set<string> | null = null;

export async function initAllowlist(client: Client): Promise<Set<string>> {
  const ids = new Set<string>();

  const envList = process.env.ISOBOT_ALLOWED_USERS;
  if (envList) {
    for (const id of envList.split(",").map((s) => s.trim()).filter(Boolean)) {
      ids.add(id);
    }
  } else if (client.application) {
    const app = await client.application.fetch();
    const owner = app.owner;
    if (owner instanceof Team) {
      for (const member of owner.members.values()) ids.add(member.user.id);
    } else if (owner) {
      ids.add(owner.id);
    }
  }

  allowed = ids;
  return ids;
}

export function isAllowed(userId: string): boolean {
  if (!allowed) return false;
  return allowed.has(userId);
}

export function describeAllowlist(): string {
  if (!allowed) return "(not loaded yet)";
  if (allowed.size === 0) return "(empty — nobody can trigger)";
  return `${allowed.size} user(s): ${[...allowed].join(", ")}`;
}
