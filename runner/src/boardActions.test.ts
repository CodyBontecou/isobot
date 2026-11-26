import assert from "node:assert/strict";
import { test } from "node:test";
import { planBoardAction, runBoardAction, type BoardAction } from "./boardActions.js";
import type { Labels } from "./config.js";

const labels: Labels = {
  proposed: "isobot:proposed", ready: "isobot:ready", building: "isobot:building", review: "isobot:review", failed: "isobot:failed",
  ship: "isobot:ship", stop: "isobot:stop", auto: "isobot:auto", cleanup: "isobot:cleanup", land: "isobot:land", content: "isobot:content",
};
const open = (...names: string[]) => ({ state: "open", labels: names.map(n => `isobot:${n}`) });

test("each action makes the same label change as its Discord reaction", () => {
  assert.deepEqual(planBoardAction("approve", open("proposed"), labels), { add: ["isobot:ready"], remove: ["isobot:proposed"] });
  assert.deepEqual(planBoardAction("approve", open("building"), labels), { noop: "it's already approved" });
  assert.ok("refuse" in planBoardAction("approve", open("stop"), labels));
  assert.ok("refuse" in planBoardAction("approve", { state: "closed", labels: [] }, labels));
  assert.deepEqual(planBoardAction("stop", open("ready"), labels), { add: ["isobot:stop"], remove: ["isobot:ready"] });
  assert.deepEqual(planBoardAction("retry", open("failed"), labels), { add: ["isobot:ready"], remove: [] });
  assert.deepEqual(planBoardAction("retry", open("stop", "review"), labels), { add: [], remove: ["isobot:stop"] });
  assert.deepEqual(planBoardAction("dismiss", open("building", "ready"), labels), { add: ["isobot:stop", "isobot:cleanup"], remove: ["isobot:ready"] });
  assert.deepEqual(planBoardAction("dismiss", open("proposed"), labels), { add: ["isobot:cleanup"], remove: [] });
});

test("runBoardAction applies the plan on configured repos only and never throws", async () => {
  const calls: string[] = [];
  const events: string[] = [];
  let issue = open("proposed");
  const deps = {
    labels, repos: () => ["Owner/App"],
    github: {
      issue: async () => issue,
      addLabels: async (_o: string, r: string, n: number, l: string[]) => { calls.push(`add ${r}#${n} ${l.join(",")}`); },
      removeLabel: async (_o: string, r: string, n: number, l: string) => { calls.push(`remove ${r}#${n} ${l}`); },
    },
    event: (jobId: string, text: string) => { events.push(`${jobId} ${text}`); },
  };
  const action = (over: Partial<BoardAction> = {}): BoardAction => ({ id: "a1", kind: "approve", repo: "owner/app", number: 7, by: "me", ...over });

  assert.deepEqual(await runBoardAction(action(), deps), { id: "a1", ok: true, text: "Approved; isobot picks it up on its next pass" });
  assert.deepEqual(calls, ["add App#7 isobot:ready", "remove App#7 isobot:proposed"]);
  assert.match(events[0], /^owner\/app#7 approve from the board by @me/);

  assert.equal((await runBoardAction(action({ repo: "someone/else" }), deps)).ok, false);
  assert.equal((await runBoardAction(action({ kind: "merge" as never }), deps)).ok, false);
  issue = { state: "closed", labels: [] };
  assert.match((await runBoardAction(action(), deps)).text, /closed/);
  deps.github.issue = async () => { throw new Error("Not Found\nmore"); };
  assert.deepEqual(await runBoardAction(action(), deps), { id: "a1", ok: false, text: "Not Found" });
});
