# HTTPS prompt API

Send `POST https://isobot-pi.costream.workers.dev/api/prompt` with a JSON body and
an `Authorization: Bearer <token>` header. A dedicated prompt token is saved in
the ignored `.env.prompt` file in the repo root; it authorizes the prompt APIs.
The existing Discord bridge API token also works.

From the repository directory:

```sh
source .env.prompt
curl --fail-with-body https://isobot-pi.costream.workers.dev/api/prompt \
  -H "Authorization: Bearer $PROMPT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello in one sentence.","conversation":"terminal"}'
```

The response contains the model's answer:

```json
{
  "conversation": "terminal",
  "requestId": "generated-uuid",
  "operationId": "generated-uuid",
  "status": "done",
  "text": "Hello! How can I help?"
}
```

| Body field | Meaning |
| --- | --- |
| `prompt` | Required nonblank string, up to 16,000 characters. |
| `conversation` | Optional name for persistent history. Defaults to `default`. |
| `requestId` | Optional retry key. Omit it for a fresh turn; repeat it with the same prompt and conversation to retrieve that turn's result. |

Conversation names and request IDs accept 1–100 letters, digits, underscores,
and hyphens. A conversation has its own SQLite-backed Pi session. Use the same
conversation for follow-ups, or a new name to start fresh. Request IDs are scoped
to the conversation. Reusing an ID with a different prompt returns HTTP 409.

The HTTPS request waits for the answer. If a connection drops, retry with the
same request ID and prompt; Pi's durable work continues. HTTP 200 responses can
have `status: "unanswered"`, an empty `text`, and a `reason` when the model could
not finish. Invalid bodies return 400, missing/invalid tokens return 401, and
unsupported methods return 405.

HTTP chat uses the same Workers AI model as the Discord agent and returns the
reply as JSON. Saved Vox captures are available through Pi's search/read tools
when you use their conversation name. See [Vox preset integration](vox-integration.md).
The Discord ticket tools run through `/api/tickets` with their
mapped repository and source-message context. The original `/api/ask` endpoint
and its conversation history remain available.

For another client, load `PROMPT_API_TOKEN` from your secret store. To replace the
prompt token, save the chosen value securely, update the Worker with
`npx wrangler secret put PROMPT_API_TOKEN` from `cloudflare`, and update your
clients. The Discord bridge uses its own API token.
