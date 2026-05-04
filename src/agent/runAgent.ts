import OpenAI from "openai";
import type { Message } from "discord.js";
import type { RepoTarget } from "../config/repos.js";
import type { ReplyContext } from "../lib/context.js";
import { executeTool, tools, type ToolContext } from "./tools.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini-2025-08-07";
const MAX_TURNS = 5;

export interface RunAgentInput {
  trigger: Message;
  replyContext: ReplyContext;
  repo: RepoTarget;
}

export interface RunAgentResult {
  issueUrl?: string;
  replied: boolean;
  turns: number;
}

let client: OpenAI | null = null;

function openai(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  client = new OpenAI({ apiKey });
  return client;
}

function buildSystemPrompt(repo: RepoTarget): string {
  return [
    "You are isobot, a Discord assistant for the isolated.tech community.",
    "A user just replied to a comment in Discord and mentioned you, asking you to turn it into a GitHub ticket.",
    `The Discord channel is mapped to the GitHub repo ${repo.owner}/${repo.repo}.`,
    "",
    "Your job, in order:",
    "1. Read the parent comment (the one being replied to) and the user's request in their reply.",
    "2. Call create_github_issue with a clear, specific title and a markdown body. The body should:",
    "   - Briefly summarize the issue in 1-2 lines.",
    "   - Quote the original Discord comment verbatim using a markdown blockquote.",
    "   - Include a 'Source' footer with a link back to the Discord message (provided to you below).",
    "3. After the issue is created, call reply_in_discord with a short confirmation including the new issue URL.",
    "4. Then stop.",
    "",
    "Rules:",
    "- Always call both tools, in that order.",
    "- Do not invent information not present in the conversation.",
    "- If the parent comment is too vague to ticketize, instead call reply_in_discord asking for more detail and skip the issue creation.",
  ].join("\n");
}

function buildUserMessage(ctx: ReplyContext): string {
  const lines: string[] = [];
  lines.push(`Server: ${ctx.guildName}`);
  lines.push(`Channel: #${ctx.channelName}`);
  lines.push("");
  lines.push("=== PARENT COMMENT (the message to ticketize) ===");
  lines.push(`Author: ${ctx.parent.authorTag}`);
  lines.push(`Posted: ${ctx.parent.createdAt}`);
  lines.push(`Discord link: ${ctx.parent.jumpUrl}`);
  lines.push("Content:");
  lines.push(ctx.parent.content || "(no text content)");
  lines.push("");
  lines.push("=== USER REQUEST (their reply mentioning you) ===");
  lines.push(`Author: ${ctx.trigger.authorTag}`);
  lines.push(`Discord link: ${ctx.trigger.jumpUrl}`);
  lines.push("Content:");
  lines.push(ctx.trigger.content);
  lines.push("");
  if (ctx.recent.length > 0) {
    lines.push("=== RECENT CHANNEL CONTEXT (oldest first) ===");
    for (const m of ctx.recent) {
      lines.push(`[${m.createdAt}] ${m.authorTag}: ${m.content}`);
    }
  }
  return lines.join("\n");
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const systemPrompt = buildSystemPrompt(input.repo);
  const userMessage = buildUserMessage(input.replyContext);

  const ctx: ToolContext = {
    trigger: input.trigger,
    replyContext: input.replyContext,
    repo: input.repo,
    state: { replied: false },
  };

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const o = openai();

  let turns = 0;
  for (let i = 0; i < MAX_TURNS; i++) {
    turns = i + 1;
    const response = await o.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    });

    const choice = response.choices[0];
    if (!choice) break;
    const msg = choice.message;
    messages.push(msg);

    const toolCalls = msg.tool_calls ?? [];
    if (choice.finish_reason === "stop" || toolCalls.length === 0) break;

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      let result: string;
      try {
        result = await executeTool(ctx, call.function.name, call.function.arguments);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        result = JSON.stringify({ ok: false, error: m });
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  return {
    issueUrl: ctx.state.issueUrl,
    replied: ctx.state.replied,
    turns,
  };
}
