import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordHistory, HistoryError, type HistoryAccess } from "./history.js";
const guild = "1443424100759634003", channel = "1443424100759634004", messageId = "1559999999999999999";
const source = { id: messageId, channel_id: channel, content: "calendar feature request", timestamp: "2026-10-29T12:00:00Z", author: { id: messageId, username: "member" }, hit: true };
function fixture(data: unknown) {
  const calls: { path: string; query: URLSearchParams }[] = [];
  const info = { id: channel, name: "chat", type: 0, parentId: null };
  const access: HistoryAccess = {
    channels: async () => [info],
    channel: async id => { if(id!==channel) throw new HistoryError(403,"inaccessible"); return info; },
    get: async (path,query) => {calls.push({path,query});return data;},
  };
  return { service: new DiscordHistory(access,guild), calls };
}
test("native historical search retains provenance, filters context, and advances pages by limit", async () => {
  const {service,calls} = fixture({ total_results: 80, messages: [[{...source,hit:false,id:"1559999999999999998"},source]] });
  const result = await service.query("search",new URLSearchParams({query:"calendar",limit:"10",offset:"20"})) as {messages:{jumpUrl:string}[];nextOffset:number};
  assert.equal(calls[0].path,`/guilds/${guild}/messages/search`);
  assert.equal(calls[0].query.get("content"),"calendar");
  assert.equal(result.messages.length,1);assert.equal(result.nextOffset,30);
  assert.equal(result.messages[0].jumpUrl,`https://discord.com/channels/${guild}/${channel}/${messageId}`);
});
test("indexing is distinguished from no matches and inaccessible results never leak", async () => {
  const pending=fixture({code:110000,retry_after:2});
  assert.equal((await pending.service.query("search",new URLSearchParams({query:"calendar"})) as {indexing:boolean}).indexing,true);
  const privateMessage=fixture({total_results:1,messages:[[{...source,channel_id:"1443424100759634009"}]]});
  const result=await privateMessage.service.query("search",new URLSearchParams({query:"calendar"})) as {messages:unknown[];inaccessible:number};
  assert.deepEqual(result.messages,[]);assert.equal(result.inaccessible,1);
});
test("channel history provides before cursors and supports around-message context", async () => {
  const {service,calls}=fixture([source]);
  const result=await service.query("messages",new URLSearchParams({channelId:channel,limit:"1"})) as {nextBefore:string};
  assert.equal(result.nextBefore,messageId);
  await service.query("messages",new URLSearchParams({channelId:channel,aroundId:messageId}));
  assert.equal(calls[1].query.get("around"),messageId);
});
test("invalid parameters, cross-channel reads and write operations are rejected before Discord reads", async () => {
  const {service,calls}=fixture([]);
  for(const params of [
    {channelId:"../../users/@me"}, {channelId:channel,limit:"99"},
    {channelId:channel,beforeId:messageId,aroundId:messageId}, {channelId:channel,token:"leak"},
  ]) await assert.rejects(service.query("messages",new URLSearchParams(Object.entries(params).filter((entry): entry is [string,string] => entry[1] !== undefined))),HistoryError);
  await assert.rejects(service.query("messages",new URLSearchParams({channelId:"1443424100759634009"})),HistoryError);
  await assert.rejects(service.query("delete",new URLSearchParams()),HistoryError);
  await assert.rejects(service.query("search",new URLSearchParams("query=x&query=y")),HistoryError);
  assert.equal(calls.length,0);
});
test("archived thread pages expose the timestamp cursor", async () => {
  const {service}=fixture({has_more:true,threads:[{id:messageId,name:"Request",parent_id:channel,thread_metadata:{archive_timestamp:"2026-09-01T00:00:00Z"}}]});
  const result=await service.query("threads",new URLSearchParams({channelId:channel})) as {nextBefore:string;hasMore:boolean};
  assert.equal(result.hasMore,true);assert.equal(result.nextBefore,"2026-09-01T00:00:00Z");
});
