#if DEBUG
import Foundation

/// Deterministic simulator data, enabled only by the app's explicit `--preview` launch argument.
/// This protocol handles every request in its private session, so fixtures never reach a network.
final class PreviewServer: URLProtocol {
    static let user = AccountUser(id: "10001", login: "cody", name: "Cody Bontecou")
    static let origin = URL(string: "https://preview.isobot.local")!
    private static let credential = String(repeating: "p", count: 43)
    private static let csrf = String(repeating: "c", count: 43)
    private static let state = FixtureState()

    static func makeClient() throws -> IsobotAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreviewServer.self]
        return try IsobotAPIClient(origin: origin, sessionCookie: credential, csrfToken: csrf,
                                   configuration: configuration)
    }

    static func reset() { state.reset() }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let response = try Self.state.respond(to: request)
            let http = HTTPURLResponse(url: request.url ?? Self.origin, statusCode: response.status,
                                       httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json", "Cache-Control": "no-store"])!
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: response.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }

    override func stopLoading() {}

    private struct FixtureResponse {
        let status: Int
        let data: Data
        init(_ value: [String: Any], status: Int = 200) throws {
            self.status = status
            self.data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        }
    }

    private struct ChatFixture {
        let prompt: String
        var status = "queued"
        var polls = 0
        var text: String?
        var reason: String?
    }

    private struct ConversationFixture {
        var entries: [[String: Any]]
        var chats: [String: ChatFixture] = [:]
        var files: [String: [String: Any]]
        var nextEntryID = 10
        var nextRevision = 5
    }

    /// All mutable fixtures stay behind this lock, including URLProtocol background callbacks.
    private final class FixtureState: @unchecked Sendable {
        private let lock = NSLock()
        private var conversations: [String: ConversationFixture] = [:]
        private var tokens = PreviewServer.seedTokens()
        private var nextTokenID = 3
        private var signedIn = true

        func reset() {
            lock.lock()
            defer { lock.unlock() }
            conversations = [:]
            tokens = PreviewServer.seedTokens()
            nextTokenID = 3
            signedIn = true
        }

        func respond(to request: URLRequest) throws -> FixtureResponse {
            lock.lock()
            defer { lock.unlock() }
            guard let url = request.url, url.host == PreviewServer.origin.host else {
                return try FixtureResponse(["error": "Preview requests cannot leave the fixture server."], status: 503)
            }
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let conversation = query.first(where: { $0.name == "conversation" })?.value ?? "vox"
            let path = url.path
            let method = request.httpMethod ?? "GET"
            let body = try bodyJSON(request)
            if path == "/api/auth/session" {
                return try FixtureResponse(signedIn
                    ? ["authenticated": true, "csrfToken": PreviewServer.csrf, "user": PreviewServer.userJSON]
                    : ["authenticated": false, "oauthConfigured": true])
            }
            if !signedIn { return try FixtureResponse(["error": "Unauthorized"], status: 401) }
            if path == "/auth/logout" {
                signedIn = false
                return try FixtureResponse(["authenticated": false])
            }
            if path == "/api/auth/tokens" {
                if method == "GET" { return try FixtureResponse(["tokens": tokens]) }
                if method == "POST" {
                    let id = String(format: "aaaaaaaa-aaaa-4aaa-8aaa-%012d", nextTokenID)
                    nextTokenID += 1
                    let token: [String: Any] = ["id": id, "name": body["name"] as? String ?? "Phone",
                        "prefix": "isobot_pat_preview…\(String(format: "%04d", nextTokenID))",
                        "scopes": body["scopes"] as? [String] ?? ["read", "write"],
                        "createdAt": "2026-10-07T12:30:00.000Z",
                        "expiresAt": body["expiresInDays"] is NSNull ? NSNull() : "2027-01-05T12:30:00.000Z",
                        "lastUsedAt": NSNull(), "revokedAt": NSNull()]
                    tokens.append(token)
                    return try FixtureResponse(token.merging(["token": "isobot_pat_\(String(repeating: "t", count: 43))"]) { _, new in new }, status: 201)
                }
            }
            if path.hasPrefix("/api/auth/tokens/"), method == "DELETE" {
                let id = String(path.dropFirst("/api/auth/tokens/".count))
                guard let index = tokens.firstIndex(where: { $0["id"] as? String == id }) else {
                    return try FixtureResponse(["error": "Token not found"], status: 404)
                }
                tokens[index]["revokedAt"] = "2026-10-07T12:45:00.000Z"
                return try FixtureResponse(["id": id, "revoked": true])
            }

            let chosenConversation = path == "/api/chat" ? (body["conversation"] as? String ?? conversation) : conversation
            var fixture = conversations[chosenConversation] ?? PreviewServer.seedConversation(chosenConversation)
            defer { conversations[chosenConversation] = fixture }

            if path == "/api/conversation" {
                let limit = Int(query.first(where: { $0.name == "limit" })?.value ?? "100") ?? 100
                let before = query.first(where: { $0.name == "before" })?.value.flatMap(Int.init)
                let eligible = fixture.entries.filter { before == nil || (Int($0["id"] as? String ?? "0") ?? 0) < before! }
                let entries = Array(eligible.suffix(limit))
                let pending = fixture.chats.filter { ["queued", "running"].contains($0.value.status) }.map {
                    ["operationId": $0.key, "status": $0.value.status]
                }.sorted { $0["operationId"]! < $1["operationId"]! }
                var result: [String: Any] = ["conversation": chosenConversation, "model": "@cf/moonshotai/kimi-k2.7-code",
                                           "busy": !pending.isEmpty, "pending": pending, "entries": entries]
                if eligible.count > entries.count, let first = entries.first?["id"] { result["nextCursor"] = first }
                return try FixtureResponse(result)
            }
            if path == "/api/chat", method == "POST" {
                let prompt = body["prompt"] as? String ?? ""
                let id = body["requestId"] as? String ?? "preview-request"
                if let existing = fixture.chats[id] {
                    guard existing.prompt == prompt else { return try FixtureResponse(["error": "requestId was already used with a different prompt"], status: 409) }
                } else {
                    fixture.chats[id] = ChatFixture(prompt: prompt)
                    fixture.entries.append(["id": String(fixture.nextEntryID), "role": "user", "text": prompt, "createdAt": "2026-10-07T12:31:00.000Z"])
                    fixture.nextEntryID += 1
                }
                return try FixtureResponse(["conversation": chosenConversation, "requestId": id, "operationId": id,
                    "accepted": true, "status": "queued", "statusUrl": "\(PreviewServer.origin)/api/chat/\(id)?conversation=\(chosenConversation)"], status: 202)
            }
            if path.hasPrefix("/api/chat/") {
                let id = String(path.dropFirst("/api/chat/".count))
                guard var chat = fixture.chats[id] else { return try FixtureResponse(["error": "Chat message not found"], status: 404) }
                let wasPending = ["queued", "running"].contains(chat.status)
                if method == "DELETE", wasPending {
                    chat.status = "unanswered"
                    chat.reason = "Request stopped."
                    chat.text = ""
                } else if method == "GET", wasPending {
                    chat.polls += 1
                    chat.status = chat.polls > 1 ? "done" : "running"
                    if chat.status == "done" {
                        chat.text = PreviewServer.reply(to: chat.prompt)
                        fixture.entries.append(["id": String(fixture.nextEntryID), "role": "assistant", "text": chat.text!, "createdAt": "2026-10-07T12:31:10.000Z"])
                        fixture.nextEntryID += 1
                    }
                }
                fixture.chats[id] = chat
                var result: [String: Any] = ["conversation": chosenConversation, "requestId": id, "operationId": id, "status": chat.status]
                if let text = chat.text { result["text"] = text }
                if let reason = chat.reason { result["reason"] = reason }
                if method == "DELETE" { result["cancelled"] = wasPending }
                return try FixtureResponse(result)
            }
            if path == "/api/workspace" {
                let files = fixture.files.values.sorted { ($0["path"] as? String ?? "") < ($1["path"] as? String ?? "") }
                return try FixtureResponse(["conversation": chosenConversation,
                    "files": files.map { $0.filter { $0.key != "content" } },
                    "totalBytes": files.reduce(0) { $0 + ($1["bytes"] as? Int ?? 0) },
                    "maxFileBytes": 131_072, "maxFiles": 500, "maxBytes": 33_554_432])
            }
            if path == "/api/workspace/file", let filePath = query.first(where: { $0.name == "path" })?.value {
                let current = fixture.files[filePath]
                if method == "GET" {
                    guard let current else { return try FixtureResponse(["error": "File not found"], status: 404) }
                    return try FixtureResponse(["conversation": chosenConversation, "file": current])
                }
                let expected = body["expectedRevision"] as? Int
                guard expected == current?["revision"] as? Int else {
                    return try FixtureResponse(["error": "File changed since it was opened", "currentRevision": current?["revision"] ?? NSNull()], status: 409)
                }
                if method == "DELETE" {
                    fixture.files.removeValue(forKey: filePath)
                    return try FixtureResponse(["conversation": chosenConversation, "deleted": true, "path": filePath])
                }
                if method == "PUT", let content = body["content"] as? String {
                    let file: [String: Any] = ["path": filePath, "content": content, "bytes": content.utf8.count,
                                             "revision": fixture.nextRevision, "updatedAt": "2026-10-07T12:35:00.000Z"]
                    fixture.nextRevision += 1
                    fixture.files[filePath] = file
                    return try FixtureResponse(["conversation": chosenConversation, "file": file], status: expected == nil ? 201 : 200)
                }
            }
            if path == "/api/notes" {
                let captures = PreviewServer.seedCaptures(conversation: chosenConversation)
                let limit = Int(query.first(where: { $0.name == "limit" })?.value ?? "25") ?? 25
                let before = query.first(where: { $0.name == "before" })?.value.flatMap(Int.init)
                let eligible = captures.filter { before == nil || ($0["sequence"] as? Int ?? 0) < before! }
                let page = Array(eligible.prefix(limit))
                var result: [String: Any] = ["conversation": chosenConversation, "items": page.map { $0.filter { !["markdown", "payload", "result", "operationId"].contains($0.key) } }]
                if eligible.count > page.count { result["nextCursor"] = page.last?["sequence"] }
                return try FixtureResponse(result)
            }
            if path.hasPrefix("/api/notes/") {
                let id = String(path.dropFirst("/api/notes/".count)).lowercased()
                if let capture = PreviewServer.seedCaptures(conversation: chosenConversation).first(where: { $0["id"] as? String == id }) {
                    return try FixtureResponse(capture)
                }
                return try FixtureResponse(["error": "Note not found"], status: 404)
            }
            if path == "/api/resources" {
                return try FixtureResponse(PreviewServer.resources(conversation: chosenConversation, fixture: fixture))
            }
            return try FixtureResponse(["error": "Preview route not found"], status: 404)
        }

        private func bodyJSON(_ request: URLRequest) throws -> [String: Any] {
            var data = request.httpBody ?? Data()
            if data.isEmpty, let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4_096)
                while stream.hasBytesAvailable {
                    let size = stream.read(&buffer, maxLength: buffer.count)
                    if size <= 0 { break }
                    data.append(contentsOf: buffer.prefix(size))
                }
            }
            guard !data.isEmpty else { return [:] }
            return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        }
    }

    private static var userJSON: [String: Any] { ["id": user.id, "login": user.login, "name": user.name ?? ""] }

    private static func seedConversation(_ name: String) -> ConversationFixture {
        let plan = """
        # Product plan

        Build a thoughtful native companion for Pi.

        - [x] Conversation history and message tools
        - [x] Workspace editing and text imports
        - [ ] Capture ideas while away from the desk

        ## API contract

        ```json
        { "conversation": "vox", "prompt": "Hello Pi" }
        ```
        """
        let files: [(String, String)] = [("README.md", "# Pi workspace\n\nNotes and files stay with this conversation.\n"),
                                       ("notes/product-plan.md", plan),
                                       ("src/example.ts", "export const greeting = (name: string) => `Hello, ${name}!`;\n"),
                                       ("data/features.json", "{\n  \"chat\": true,\n  \"workspace\": true,\n  \"captures\": true\n}\n")]
        var indexed: [String: [String: Any]] = [:]
        for (index, file) in files.enumerated() {
            indexed[file.0] = ["path": file.0, "content": file.1, "bytes": file.1.utf8.count,
                               "revision": index + 1, "updatedAt": "2026-10-07T10:24:00.000Z"]
        }
        let entries: [[String: Any]] = name == "vox" ? [
            ["id": "1", "role": "user", "text": "Help me make room for a good idea today.", "createdAt": "2026-10-07T10:20:00.000Z"],
            ["id": "2", "role": "assistant", "text": "Start with one thought that keeps returning. We can turn it into a small next step, and keep the context here.", "createdAt": "2026-10-07T10:20:05.000Z"],
            ["id": "3", "role": "user", "text": "Let’s build a native companion for Pi. What’s already in my workspace?", "createdAt": "2026-10-07T10:23:00.000Z"],
            ["id": "4", "role": "assistant", "text": "I’ll take a look at your notes.", "createdAt": "2026-10-07T10:23:03.000Z",
             "toolCalls": [["id": "workspace-tool", "name": "list_workspace_files", "arguments": "{\"query\":\"\"}"]]],
            ["id": "5", "role": "tool", "text": "README.md\nnotes/product-plan.md\nsrc/example.ts\ndata/features.json", "createdAt": "2026-10-07T10:23:04.000Z",
             "toolResult": ["id": "workspace-tool", "name": "list_workspace_files", "error": false]],
            ["id": "6", "role": "assistant", "text": "You have a **product plan**, a small code example, and a feature checklist.\n\nThe next step is simple: open **Workspace**, review the plan, and tell me what you’d like to tackle first.", "createdAt": "2026-10-07T10:23:08.000Z"]
        ] : []
        return ConversationFixture(entries: entries, files: name == "vox" ? indexed : [:])
    }

    private static func seedCaptures(conversation: String) -> [[String: Any]] {
        guard conversation == "vox" else { return [] }
        return [
            ["conversation": conversation, "sequence": 3, "id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000003", "mode": "prompt",
             "receivedAt": "2026-10-07T11:15:00.000Z", "preview": "A quieter way to plan the week", "status": "done",
             "markdown": "# A quieter way to plan the week\n\nKeep **three priorities**, then choose one next action.\n\n| Priority | Next step |\n| --- | --- |\n| Native app | Test the first conversation |\n| Writing | Save a rough opening |\n| Outside | Walk before lunch |\n\n```swift\nlet focus = priorities.first\n```",
             "operationId": "vox:bbbbbbbb-bbbb-4bbb-8bbb-000000000003",
             "result": ["operationId": "vox:bbbbbbbb-bbbb-4bbb-8bbb-000000000003", "status": "done", "text": "Choose the native app first. One complete conversation will tell us more than polishing every screen at once."],
             "payload": ["id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000003", "source": "Vox", "tags": ["planning", "product"], "recordedAt": "2026-10-07T11:15:00Z"]],
            ["conversation": conversation, "sequence": 2, "id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000002", "mode": "memory",
             "receivedAt": "2026-10-07T09:40:00.000Z", "preview": "An idea from the morning walk", "status": "stored",
             "markdown": "# An idea from the morning walk\n\nMake capturing a thought feel as light as sending a message.\n\n- Preserve the original words.\n- Let the conversation connect them later.\n- Keep the source easy to export.",
             "payload": ["id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000002", "source": "Vox", "durationSeconds": 42, "location": NSNull()]],
            ["conversation": conversation, "sequence": 1, "id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "mode": "prompt",
             "receivedAt": "2026-10-06T18:10:00.000Z", "preview": "A question to revisit tomorrow", "status": "unanswered",
             "markdown": "What would make this app useful on a busy day?",
             "result": ["operationId": "vox:bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "status": "unanswered", "text": "", "reason": "Request stopped."],
             "payload": ["id": "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "source": "Vox"]]
        ]
    }

    private static func reply(to prompt: String) -> String {
        """
        Let’s give that a concrete next step.

        You said: “\(prompt)”

        1. Capture the outcome you want in **notes/product-plan.md**.
        2. Pick the smallest action you can finish today.
        3. Come back here with what you learned.

        Your files and captures stay with this conversation, so we can build on the context next time.
        """
    }

    private static func seedTokens() -> [[String: Any]] {
        [["id": "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "name": "Vox on my phone", "prefix": "isobot_pat_preview…2401",
          "scopes": ["read", "write"], "createdAt": "2026-10-01T09:00:00.000Z", "expiresAt": "2027-01-01T09:00:00.000Z",
          "lastUsedAt": "2026-10-07T11:15:00.000Z", "revokedAt": NSNull()],
         ["id": "aaaaaaaa-aaaa-4aaa-8aaa-000000000002", "name": "Old laptop", "prefix": "isobot_pat_preview…0952",
          "scopes": ["read"], "createdAt": "2026-08-01T09:00:00.000Z", "expiresAt": NSNull(), "lastUsedAt": "2026-09-01T09:00:00.000Z",
          "revokedAt": "2026-09-04T09:00:00.000Z"]]
    }

    private static func resources(conversation: String, fixture: ConversationFixture) -> [String: Any] {
        let modelUsage: [String: Any] = ["key": "@cf/moonshotai/kimi-k2.7-code", "inputTokens": 28_420, "outputTokens": 4_210,
            "cacheReadTokens": 15_880, "cacheWriteTokens": 0, "totalTokens": 48_510, "recordedCatalogEstimateUSD": 0.0438]
        let usage = modelUsage.filter { $0.key != "key" }.merging(["scope": "assistant lifetime", "models": [modelUsage]]) { _, new in new }
        let storageBytes = fixture.files.values.reduce(0) { $0 + ($1["bytes"] as? Int ?? 0) }
        let busy = fixture.chats.values.contains { ["queued", "running"].contains($0.status) }
        return ["conversation": conversation,
            "runtime": ["model": "@cf/moonshotai/kimi-k2.7-code", "provider": "workers-ai", "harness": "PiHarness", "busy": busy,
                        "pendingCount": fixture.chats.values.filter { ["queued", "running"].contains($0.status) }.count, "sessionCount": 1],
            "storage": ["databaseBytes": 286_720, "workspaceFiles": fixture.files.count, "workspaceBytes": storageBytes,
                        "captures": conversation == "vox" ? 3 : 0],
            "usage": usage,
            "bindings": [["name": "Assistant", "kind": "Durable Object", "description": "Conversations, workspace and captured notes in SQLite"],
                         ["name": "AI", "kind": "Workers AI", "description": "Cloudflare model inference"],
                         ["name": "AccountAuth", "kind": "Durable Object", "description": "Console accounts and sessions"]],
            "pricing": ["currency": "USD", "checkedAt": "2026-10-07", "actualBill": NSNull(),
                "model": ["source": "https://developers.cloudflare.com/workers-ai/platform/pricing/", "label": "Workers AI token rates",
                          "inputPerMillion": 0.95, "outputPerMillion": 4, "cachedInputPerMillion": 0.19],
                "rates": [["label": "Workers paid plan", "unit": "account/month", "usd": 5,
                           "included": "Minimum account charge; shared across projects", "source": "https://developers.cloudflare.com/workers/platform/pricing/"],
                          ["label": "SQLite storage", "unit": "GB-month", "usd": 0.2,
                           "included": "5 GB-month included", "source": "https://developers.cloudflare.com/durable-objects/platform/pricing/"]],
                "storageEstimateUSDPerMonth": 0.000057344,
                "notes": ["Preview fixture values are sample data.", "Pi’s recorded catalog estimate is not a charge or invoice.",
                          "Account allowances and the actual provider bill are unavailable here."]]]
    }
}
#endif
