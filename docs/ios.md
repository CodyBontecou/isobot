# Pi for iOS

`ios/` contains the native SwiftUI client for the Pi web console. It uses the
same Worker APIs, named conversations, saved Vox captures and shared workspace;
the app does not create a separate agent or copy its history. It supports iPhone
and iPad on iOS 17 or later.

## Build and run

Install Xcode with an iOS SDK and [XcodeGen](https://github.com/yonaskolb/XcodeGen).
From the repository root, generate the project and open it:

```sh
xcodegen generate --spec ios/project.yml
open ios/Isobot.xcodeproj
```

Select the **Isobot** scheme and an iPhone or iPad Simulator, then run. The
project definition is `ios/project.yml`; regenerate the project after changing
its targets, settings or source layout.

For a preview without signing in, add `--preview` under **Edit Scheme → Run →
Arguments** in the Debug configuration. It supplies isolated in-memory fixtures
for all screens and never sends network requests or changes saved credentials
or connection preferences. Remove the argument to connect to your real agent.
Release builds do not include the preview server.

For a walkthrough without credentials, add `--preview` to the scheme's launch
arguments in a Debug build. This uses an isolated fixture server for chat,
workspace, captures, resources and account controls; fixture requests never
contact the Worker. Remove the argument to use your actual server.

For a command-line Simulator build:

```sh
xcodebuild -project ios/Isobot.xcodeproj -scheme Isobot \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

To install on your iPhone, add your Apple account in Xcode and select your team
for the Isobot target under **Signing & Capabilities**. Automatic signing is
enabled, but no development team or signing credentials are committed. Select
the connected device and run. See Apple's
[device and Simulator guide](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)
for device setup.

A signed Release build was installed and launched on Cody's iPhone 17 Pro on
October 7, 2026. The phone opened the native sign-in screen and detected the
production Worker's configured GitHub login. Complete **Continue with GitHub**
on the phone to connect your account.

The API models and network client also form a Swift package that can be tested
on macOS without a Simulator:

```sh
swift test --package-path ios
```

Run the **IsobotTests** target in Xcode (⌘U) to check conversation state,
pagination, retry identities, expired sessions and responses arriving after a
conversation switch.

Xcode's **Product > Test** runs the app-hosted tests in `ios/IsobotTests`,
including conversation switching during requests, pagination, retry identity
and expired-connection handling.

## Console features

| Web functionality | iOS implementation |
| --- | --- |
| Connect to Pi | GitHub sign-in, bearer-token fallback and configurable server origin |
| Named conversations | Switch or create conversation names; retain a draft per conversation |
| Chat history | Read saved messages, load older history, render Markdown and copy messages |
| Submit prompts | Persistent request IDs, pending state, automatic status polling, retry and stop |
| Shared files | Browse and search files, create/import UTF-8 text, edit, preview, share/export and delete |
| Concurrent file edits | Revision checks preserve the local draft when the saved version changed |
| Vox captures | Browse saved captures, read the original Markdown and export it |
| Resources | Inspect agent usage, storage, runtime and available cost information |
| Account tokens | GitHub session owners can list, create and revoke scoped API tokens |

Captures include the source JSON and saved result alongside Markdown, with
paging and exports for each representation. The resources view includes the
server's pricing sources and measurement notes. File drafts stay in memory;
offline and background editing are not implemented.

The app connects to `https://isobot-pi.costream.workers.dev` by default. Use
**Server settings** before connecting to choose another Worker HTTPS origin.
Localhost HTTP is accepted for development. The server and conversation choices
are preferences; no authentication secrets are included in the app's source.

An existing Vox, prompt or scoped account token uses the deployed conversation,
chat, workspace and resource APIs directly. Read-only tokens can browse these
surfaces; sending prompts and changing files require write access. Token
connections stay in memory and must be entered again after relaunch. Account
token management requires GitHub sign-in. The server continues to enforce its
scope and account allowlist checks on every request.

## Native GitHub sign-in

The native GitHub sign-in endpoints were deployed to the default Worker on
October 7, 2026; see the [deployment record](deployment.md). When deploying to
another Worker, include the native handoff in `account-routes.ts`,
`account-store.ts` and `account-auth.ts`. The existing browser OAuth configuration
can be reused. No deployment is performed by building or running the app.

The GitHub OAuth app still uses the HTTPS callback:

```text
https://isobot-pi.costream.workers.dev/auth/github/callback
```

Keep `AUTH_ORIGIN`, `GITHUB_OAUTH_ALLOWED_IDS`, `GITHUB_OAUTH_CLIENT_ID` and
`GITHUB_OAUTH_CLIENT_SECRET` configured as described in
[GitHub login setup](github-login.md). Client credentials belong in Worker
secrets. The iOS app is a public OAuth client and contains no client secret.

The native flow uses `ASWebAuthenticationSession`:

1. The app creates a random verifier and its S256 PKCE challenge, then opens
   `GET /auth/github/login?client=ios&code_challenge=…&conversation=vox`.
2. The Worker stores the app challenge with the browser-bound OAuth flow and
   completes its existing GitHub identity and allowlist checks. A separate
   short-lived browser marker lets invalid or expired state return a native
   error callback; it grants no authentication authority.
3. The Worker redirects to the fixed `isobot://auth?code=…` callback. This code
   expires after two minutes, can be used once and is stored only as a hash.
   Session credentials and GitHub access tokens never enter the callback URL.
4. The app posts `{ "code": "…", "codeVerifier": "…" }` to
   `POST /api/auth/native/exchange` with `Content-Type: application/json` and an
   `Origin` matching the configured Worker origin.
5. A successful exchange returns `credential`, `csrfToken`, `user` and the
   seven-day session's ISO 8601 `expiresAt`. The app stores the session credential
   in the device's Keychain and obtains fresh session identity/CSRF state when
   restoring the connection.

Authenticated requests send `Cookie: __Host-isobot_session=…`; mutations also
send the matching `Origin` and `X-CSRF-Token`. Account administration retains
its cookie-only authorization rules. Sign-out clears the local session and
requests server-side revocation. A cancelled or denied GitHub login leaves the
app signed out.

The `isobot` URL scheme is registered in `ios/Isobot/Info.plist`. The Worker
accepts no caller-supplied native redirect URI. Unknown or replayed codes,
incorrect verifiers, expired proofs and accounts outside the current allowlist
cannot produce a session.

## Backend checks

The native authorization tests exercise the real Workers runtime and SQLite
storage, including simultaneous exchanges, expiry boundaries, restart
persistence, credential hashing and the existing web login behavior:

```sh
node --import tsx --test cloudflare/src/native-auth-*.test.ts \
  cloudflare/src/account-*.test.ts
npm --prefix cloudflare run typecheck
```
