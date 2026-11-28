import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Pin } from 'lucide-react';
import { Chip, Empty, getJson, rel, full, SearchBox, Section, SignedOut } from './common';
import type { Artifact, ArtifactList } from './types';

/**
 * Claude's published artifacts (designs, pages, docs on claude.ai), grouped by project. The list is pushed by
 * scripts/push-artifacts.mjs; the sidebar's repository filter keeps the artifacts filed under that repo.
 */

/** Projects isobot runs come first, in this order; the rest follow alphabetically, "Other" last. */
const ORDER = ['Vox.md', 'Health.md', 'Whereday', 'GitSync.md', 'time.md', 'Instarep.ly', 'isobot'];

export function Artifacts({ repo, q, setQ, signedOut }: { repo: string; q: string; setQ: (q: string) => void; signedOut: () => void }) {
  const [list, setList] = useState<(ArtifactList & { receivedAt: string }) | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    getJson<{ artifacts: (ArtifactList & { receivedAt: string }) | null }>('/api/artifacts', abort.signal)
      .then(body => setList(body.artifacts))
      .catch(e => { if (e instanceof SignedOut) signedOut(); else if (!abort.signal.aborted) setError(String(e.message ?? e)); });
    return () => abort.abort();
  }, [signedOut]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = (list?.artifacts ?? []).filter(a => (!repo || a.repo === repo)
      && (!needle || `${a.title} ${a.project} ${a.kind}`.toLowerCase().includes(needle)));
    const byProject = new Map<string, Artifact[]>();
    for (const a of shown) byProject.set(a.project, [...(byProject.get(a.project) ?? []), a]);
    const rank = (p: string) => { const i = ORDER.indexOf(p); return i >= 0 ? i : p === 'Other' ? 1000 : 100; };
    return [...byProject.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([project, items]) => [project, items.sort((x, y) => Number(y.pinned) - Number(x.pinned) || (y.updatedAt ?? '').localeCompare(x.updatedAt ?? ''))] as const);
  }, [list, repo, q]);

  if (error) return <Empty title="Couldn't load artifacts" body={error} />;
  if (list === undefined) return <div className="center"><span className="spinner" /></div>;
  if (list === null) return <Empty title="No artifacts yet" body="Push a list with board/scripts/push-artifacts.mjs (docs/board.md#artifacts)." />;

  const count = groups.reduce((n, [, items]) => n + items.length, 0);
  return (
    <>
      <div className="toolbar">
        <SearchBox q={q} setQ={setQ} placeholder="Search artifacts" />
        <span className="meta" title={full(list.at)}>{count} of {list.artifacts.length} · listed {rel(list.at)}</span>
      </div>
      {!groups.length ? <Empty title="Nothing here" body={repo ? 'No artifacts are filed under this repository.' : 'No artifact matches.'} /> : null}
      <div className="artifact-groups">
        {groups.map(([project, items]) => (
          <Section key={project} title={project} action={<em className="meta">{items.length}</em>}>
            <div className="list">
              {items.map(a => (
                <a key={a.url} className="row" href={a.url} target="_blank" rel="noopener noreferrer">
                  {a.pinned ? <Pin size={14} /> : <ExternalLink size={14} />}
                  <div className="row-main">
                    <span className="row-title">{a.title}</span>
                  </div>
                  <div className="row-chips">
                    <Chip tone={a.kind === 'Design' ? 'accent' : a.kind === 'Doc' ? 'info' : 'muted'}>{a.kind}</Chip>
                    {a.shared ? <Chip tone="warn">shared</Chip> : null}
                  </div>
                  <span className="row-time" title={full(a.updatedAt)}>{a.updatedAt ? new Date(a.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—'}</span>
                </a>
              ))}
            </div>
          </Section>
        ))}
      </div>
    </>
  );
}
