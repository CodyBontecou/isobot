import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { frontmatter, openReview, parseActions, readNotebook, redactor } from "./voxNotebook.js";

function notebook(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vox-notebook-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const note = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}`;

test("frontmatter reads the notebook's YAML subset and never keeps location keys", () => {
  const { meta, rest } = frontmatter(note([
    "kind: idea", "captured: 2026-11-17T15:46Z", "place: Rincón", "lat: 18.3", "projects: [isobot, health-md]",
    "status: open        # open | in-progress | done | parked", "links:", "  - https://github.com/o/r/issues/1", "  - notes/bugs/x.md",
  ].join("\n"), "# Title\n\nBody"));
  assert.deepEqual(meta, {
    kind: "idea", captured: "2026-11-17T15:46Z", projects: ["isobot", "health-md"], status: "open",
    links: ["https://github.com/o/r/issues/1", "notes/bugs/x.md"],
  });
  assert.equal(rest.trim(), "# Title\n\nBody");
});

test("the notebook goes to the board without journal entries or place names", () => {
  const dir = notebook({
    "notes/ideas/2026-11-27-labels.md": note("kind: idea\ncaptured: 2026-11-27T15:42Z\nplace: Rincón\nsource: Vox/2026-11-27-18.md\nprojects: [vox.md]\nlinks: [notes/journal/2026-11-19-trip.md]",
      "# Labels on the nav bar\n\nSaid this on the beach in Rincón, see [trip](../journal/2026-11-19-trip.md).\n\n> quote"),
    "notes/journal/2026-11-19-trip.md": note("kind: journal\nplace: Old San Juan", "# Trip\n\nPrivate."),
    "ACTIONS.md": "# Actions\n\n## vox.md\n- [ ] Add labels ([#5](https://github.com/o/vox.md/issues/5), [note](notes/ideas/2026-11-27-labels.md))\n- [x] Done thing\n\n## personal\n- [ ] Reply about the trip ([note](notes/journal/2026-11-19-trip.md))\n",
    "THEMES.md": "# Themes\n\n## Capture with zero friction\nFrom anywhere, even Old San Juan.\n",
    "INBOX-REVIEW.md": "# Inbox review\n\n## Open\n\n- **Audio only (2026-11-27, Rincón):** one embed\n  to listen to.\n- About the trip ([note](notes/journal/2026-11-19-trip.md))\n\n## Done\n\n- old\n",
    "state/last-summary.md": "**Vox run: 1 note (Rincón, 2026-11-27)**\n",
  });
  const vox = readNotebook(dir, new Date("2026-11-27T18:00:00Z"))!;
  assert.equal(vox.privateCount, 1);
  assert.deepEqual(vox.notes.map(n => n.path), ["notes/ideas/2026-11-27-labels.md"]);
  const [n] = vox.notes;
  assert.equal(n.kind, "idea");
  assert.equal(n.title, "Labels on the nav bar");
  assert.equal(n.captured, "2026-11-27T15:42:00.000Z");
  assert.equal(n.source, "2026-11-27-18.md");
  assert.deepEqual(n.links, []);
  assert.equal(n.body, "Said this on the beach in, see trip.\n\n> quote");
  assert.deepEqual(vox.actions.map(a => [a.project, a.done, a.notes]), [["vox.md", false, ["notes/ideas/2026-11-27-labels.md"]], ["vox.md", true, []]]);
  assert.deepEqual(vox.themes, [{ title: "Capture with zero friction", body: "From anywhere, even." }]);
  assert.deepEqual(vox.review, ["**Audio only (2026-11-27):** one embed\nto listen to."]);
  assert.equal(vox.lastRun?.text, "**Vox run: 1 note (2026-11-27)**");
  const all = JSON.stringify(vox);
  for (const secret of ["Rincón", "Old San Juan", "Private", "journal/", "trip.md"]) assert.ok(!all.includes(secret), secret);
});

test("no notebook, no Vox view", () => {
  assert.equal(readNotebook(path.join(tmpdir(), "no-such-notebook-here")), null);
});

test("the redactor takes whole words only and tidies what's around them", () => {
  const redact = redactor(["Rincón", "Rio"]);
  assert.equal(redact("(`a.md`) (Rincón) has"), "(`a.md`) has");
  assert.equal(redact("Rio trip; Riot games; rincón"), "trip; Riot games");
  assert.equal(redactor([])("Rincón"), "Rincón");
});

test("actions carry continuation lines and only link notes that exist", () => {
  const actions = parseActions("## isobot\n- [ ] One ([note](notes/ideas/a.md))\n  more text\n- [X] Two ([note](notes/ideas/missing.md))\n", new Set(["notes/ideas/a.md"]));
  assert.deepEqual(actions, [
    { project: "isobot", text: "One ([note](notes/ideas/a.md)) more text", done: false, notes: ["notes/ideas/a.md"] },
    { project: "isobot", text: "Two ([note](notes/ideas/missing.md))", done: true, notes: [] },
  ]);
  assert.deepEqual(openReview("# x\n\n## Later\n\n- no\n"), []);
  assert.deepEqual(openReview("## Open\n\n- **Two things:**\n  - one;\n  - two.\n\n  Which?\n- Next\n"),
    ["**Two things:**\n- one;\n- two.\n\nWhich?", "Next"]);
});
