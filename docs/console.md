# Pi chat and workspace

Open [the Pi console](https://isobot-pi.costream.workers.dev/console?conversation=vox)
to chat with the durable agent and manage the files it can use. The `conversation`
parameter selects the same persistent agent used by that Vox preset. A new
conversation name creates an independent workspace and history.

The console follows your system's light or dark appearance and updates when that
preference changes, including the chat, workspace, and account dialogs.

Sign in with GitHub when account OAuth is configured, or use the advanced bearer
token connection with your existing Vox token. Bearer credentials stay in memory
and are cleared on disconnect. Account sessions use secure, HTTP-only cookies;
mutations include the session CSRF token.

## Chat

Send a message with Enter; Shift+Enter adds a newline. The console presents the
stored transcript, Markdown replies, and expandable tool calls and results.
Earlier messages remain available through **Load earlier**. New submissions use
durable operation IDs, so retrying a submission retains its original identity.
The chat follows new replies while you are at the bottom. Scroll upward to read
earlier messages while Pi works; scroll back down or use the down-arrow button
to resume following the conversation.
The agent continues accepted work if the browser disconnects. Refreshing or
reconnecting retrieves persisted messages and pending operations.

## Workspace

The workspace panel contains three views:

- **Files:** Create, upload, browse, read, edit, download, and delete UTF-8 text
  files. Paths such as `notes/project.md` organize files into folders. These
  files live in the conversation's Durable Object SQLite database, and the
  agent's workspace tools read and write the same store.
- **Captures:** Browse archived Vox memory and prompt captures, view their
  results, and download their Markdown, source JSON, and responses.
- **Resources:** Inspect the active model and provider, pending operations,
  workspace and database storage, recorded model usage, and configured
  Cloudflare bindings.

File edits use revision checks. If another browser or the agent changes a file,
saving returns a conflict instead of overwriting the newer version. Files are
bounded to 128 KiB of UTF-8 text. The workspace is a durable document store; it
does not expose the Worker's source code, environment secrets, or a host disk.

The resource view links to the published Workers, Durable Objects, and Workers AI
rates. Its measurements belong to the selected conversation; Cloudflare account
allowances apply across the account. Pi's recorded token costs are catalog
estimates and do not represent ChatGPT subscription charges or a Cloudflare
invoice. Account-level CPU, request billing, and the actual bill are unavailable
through the current agent bindings.

## Development

Run `npm run agent:dev` from the repository root. The Cloudflare package builds
the React console before starting Wrangler. `npm --prefix cloudflare run
build:console` rebuilds its JavaScript and CSS in `cloudflare/public/console-assets`.
These generated files are ignored by Git and uploaded as Worker static assets.

The frontend adapts Vercel [AI Elements](https://elements.ai-sdk.dev/) Conversation
and Message components, with its source attribution and Apache 2.0 license kept
alongside the components. Model execution continues through the existing Pi
harness and its durable HTTP APIs.
