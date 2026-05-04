import reposJson from "./repos.json" with { type: "json" };

export interface RepoTarget {
  owner: string;
  repo: string;
}

type RepoMap = Record<string, RepoTarget>;

const repos: RepoMap = reposJson as RepoMap;

export interface ChannelLocation {
  category: string | null;
  channel: string;
}

export function channelToRepo(loc: ChannelLocation): RepoTarget | null {
  const candidates: string[] = [];
  if (loc.category) candidates.push(`${loc.category}/${loc.channel}`, loc.category);
  candidates.push(loc.channel);

  for (const raw of candidates) {
    const key = raw.toLowerCase();
    for (const [k, v] of Object.entries(repos)) {
      if (k.toLowerCase() === key) return v;
    }
  }
  return null;
}

export function listMappedKeys(): string[] {
  return Object.keys(repos);
}

export function repoToCategoryKey(target: RepoTarget): string | null {
  for (const [k, v] of Object.entries(repos)) {
    if (
      v.owner.toLowerCase() === target.owner.toLowerCase() &&
      v.repo.toLowerCase() === target.repo.toLowerCase()
    ) {
      return k;
    }
  }
  return null;
}
