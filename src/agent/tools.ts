import type OpenAI from "openai";
import type { Message } from "discord.js";
import { createIssue } from "../github/issues.js";
import type { RepoTarget } from "../config/repos.js";
import type { ReplyContext } from "../lib/context.js";

export interface ToolContext {
  trigger: Message;
  replyContext: ReplyContext;
  repo: RepoTarget;
  state: {
    issueUrl?: string;
    replied: boolean;
  };
}

export const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_github_issue",
      description:
        "Create a GitHub issue in the repository this Discord channel is mapped to. Use a clear, action-oriented title (under 80 chars) and a body that summarizes the problem, quotes the original Discord comment verbatim in a markdown blockquote, and ends with a 'Source' footer linking back to the Discord message.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short, action-oriented issue title (max ~80 chars).",
          },
          body: {
            type: "string",
            description: "Markdown body: 1-2 line summary, quoted block of the original Discord comment, any relevant context, and a 'Source' footer linking back to the Discord message.",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Optional GitHub labels (e.g., ['bug'], ['enhancement']). Use only if obvious.",
          },
        },
        required: ["title", "body"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply_in_discord",
      description:
        "Send a reply in the Discord channel where the user mentioned isobot. Use this once at the end to confirm what you did (e.g., 'Created issue #42: <url>'). Keep it short.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Discord reply content (markdown). Keep under 500 chars.",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeTool(
  ctx: ToolContext,
  name: string,
  argsJson: string,
): Promise<string> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(argsJson || "{}");
  } catch {
    throw new Error(`Invalid JSON arguments for ${name}`);
  }

  if (name === "create_github_issue") {
    const title = String(input.title ?? "").trim();
    const body = String(input.body ?? "").trim();
    const labels = Array.isArray(input.labels) ? (input.labels as string[]) : undefined;
    if (!title || !body) throw new Error("title and body are required");

    const issue = await createIssue({
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      title,
      body,
      labels,
    });
    ctx.state.issueUrl = issue.url;
    return JSON.stringify({ ok: true, number: issue.number, url: issue.url });
  }

  if (name === "reply_in_discord") {
    const content = String(input.content ?? "").trim();
    if (!content) throw new Error("content is required");
    await ctx.trigger.reply({ content, allowedMentions: { repliedUser: false } });
    ctx.state.replied = true;
    return JSON.stringify({ ok: true });
  }

  throw new Error(`Unknown tool: ${name}`);
}
