# Vox.md → Pi

Each Vox capture preset can choose how Pi handles its text by using a different
HTTP endpoint URL. Both modes preserve the original Markdown and the incoming
JSON fields in SQLite on the conversation's Durable Object.

| Preset behavior | Endpoint URL |
| --- | --- |
| Send an instruction to Pi and save the result | `https://isobot-pi.costream.workers.dev/api/vox?mode=prompt&conversation=vox` |
| Save a note as memory without running the model | `https://isobot-pi.costream.workers.dev/api/vox?mode=memory&conversation=vox` |

In Vox, edit your custom preset, choose **Destination → Target → HTTP**, paste
the appropriate URL, and save the raw value of `PROMPT_API_TOKEN` from the
gitignored `.env.prompt` file into **Bearer Token**. Vox adds `Bearer` itself.
Save the token for each preset's exact URL, then use **Send Test**. A test checks
the connection without adding a note or running Pi.

Use the same `conversation` on both presets to share memory. You can choose
different names such as `work` and `journal` for separate histories and saved
notes. Conversation names accept 1–100 letters, digits, underscores and hyphens.
The default mode is `memory`, and the default conversation is `vox`.

Your prompt preset's Markdown becomes the current instruction. For example,
"Search my saved notes for the workshop plan and list the next three actions."
Pi has tools to search and read the saved captures in that conversation. A
memory preset saves reference material without interpreting instructions inside
it or spending a model call.

Vox currently posts its captured text and transcript metadata. Its HTTP target
does not upload attachments, filenames, or the Markdown file produced by a
directory preset's templates and frontmatter. Markdown present in `text` is
preserved exactly. If a recording includes nonblank `cleanedText`, prompt mode
uses that text as the instruction while retaining the original `text` and all
metadata.

## Receipt and retries

Vox sends `Content-Type: application/json; charset=utf-8`, its bearer token, and
`Idempotency-Key` matching the capture's `id` UUID. Its existing request body
works directly:

```json
{
  "id": "36b5e7e1-5791-4595-82b0-3be2c581bdd2",
  "text": "# Workshop\n\nThe workshop starts at 10:30 on Friday.\n",
  "source": "vox",
  "recorded_at": "2026-10-07T12:00:00Z"
}
```

Memory mode returns 201 after storage, or 200 for an identical retry. Prompt
mode returns 202 after storage and Pi's durable admission; model work continues
in the background. Reusing an ID with different content or mode in the same
conversation returns 409. Retry with the original body and URL. A 2xx response
confirms delivery to the server, not completion of the model's answer.

The entire JSON body can be up to 1 MiB. Prompt instructions can be up to 64,000
characters; memory mode can store larger notes within the body limit. Recording
timestamps in Swift's 2001 epoch remain intact in the original JSON.

## Retrieve and export

For a browser interface, open [the Pi viewer](https://isobot-pi.costream.workers.dev/console?conversation=vox)
and connect with the same bearer token. It shows your conversation and captures,
including the response to the latest prompt.
[Conversation and runtime logs](agent-inspection.md) covers inspection in detail.

Every read uses the same bearer token. List saved notes:

```sh
source .env.prompt
curl --fail-with-body \
  'https://isobot-pi.costream.workers.dev/api/notes?conversation=vox&limit=25' \
  -H "Authorization: Bearer $PROMPT_API_TOKEN"
```

The list returns metadata and previews, newest first. If `nextCursor` is present,
pass it as `before` to retrieve the next page. `limit` accepts 1–100. A listed
prompt may show `queued` until its completion is checked; the individual note
endpoint resolves its current Pi status and retains the terminal result.

For a capture UUID `ID`, these authenticated URLs provide portable exports:

| URL path, followed by `?conversation=vox` | Result |
| --- | --- |
| `/api/notes/ID` | Original text and payload, metadata, current status, and Pi result when complete. |
| `/api/notes/ID.md` | Exact original Markdown, downloadable as `ID.md`. |
| `/api/notes/ID/source.json` | Original incoming JSON fields. |
| `/api/notes/ID/response.md` | Pi's completed answer as a separate Markdown file. |

The response export returns 202 while Pi is working, 422 for an unanswered
operation, and 404 for memory-only captures. You can also query memory through
the regular prompt API:

```sh
curl --fail-with-body https://isobot-pi.costream.workers.dev/api/prompt \
  -H "Authorization: Bearer $PROMPT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"conversation":"vox","prompt":"Search my saved captures for the workshop plan."}'
```

SQLite keeps original text, metadata, idempotency records and Pi's conversation
together. It is a good initial fit for text captures: transactional persistence
and downloadable `.md`/JSON exports without an extra storage service.
[Cloudflare recommends SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).
The archive has no automatic expiration. Attachments would need a separate
upload contract and object storage if added later.
