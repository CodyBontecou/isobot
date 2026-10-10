import Foundation

public enum APIError: Error, LocalizedError, Sendable {
    case invalidConfiguration(String)
    case invalidInput(String)
    case authenticationRequired
    case sessionRequired
    case http(statusCode: Int, message: String, currentRevision: Int?)
    case invalidResponse

    public var statusCode: Int? {
        if case .http(let value, _, _) = self { return value }
        return nil
    }

    public var isUnauthorized: Bool { statusCode == 401 }
    public var isConflict: Bool { statusCode == 409 }
    public var currentRevision: Int? {
        if case .http(_, _, let value) = self { return value }
        return nil
    }

    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration(let message), .invalidInput(let message): return message
        case .authenticationRequired: return "Connect to your agent first."
        case .sessionRequired: return "Sign in with GitHub to manage your account."
        case .http(let status, let message, _):
            return status == 401 ? "Your connection expired or the token was not accepted. Connect again to continue." : message
        case .invalidResponse: return "The agent returned an unreadable response. Please try again."
        }
    }
}

/// An origin-bound client with a private, ephemeral transport. Session credentials are the raw
/// cookie value; the client supplies `Cookie: __Host-isobot_session=<credential>` itself.
/// API bearer tokens take precedence over session credentials for conversation endpoints.
public struct IsobotAPIClient: Sendable {
    public let origin: URL
    private let bearerToken: String?
    private let sessionCookie: String?
    private let csrfToken: String?
    private let transport: URLSession

    public init(origin: URL, bearerToken: String? = nil, sessionCookie: String? = nil,
                csrfToken: String? = nil, configuration: URLSessionConfiguration? = nil) throws {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(),
              !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else {
            throw APIError.invalidConfiguration("Use the agent’s HTTPS origin, such as https://agent.example.com. Localhost HTTP is allowed for development.")
        }
        components.scheme = scheme
        components.host = host
        components.path = ""
        if (scheme == "https" && components.port == 443) || (scheme == "http" && components.port == 80) {
            components.port = nil
        }
        guard let normalized = components.url else { throw APIError.invalidConfiguration("The agent URL is invalid.") }
        self.origin = normalized

        let token = bearerToken?.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^Bearer\\s+", with: "", options: [.regularExpression, .caseInsensitive])
        if let token, !token.isEmpty {
            guard !token.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
                throw APIError.invalidConfiguration("The bearer token contains invalid characters.")
            }
            self.bearerToken = token
        } else { self.bearerToken = nil }
        if let sessionCookie, !APIValidation.isSessionSecret(sessionCookie) {
            throw APIError.invalidConfiguration("The session credential is invalid.")
        }
        if let csrfToken, !APIValidation.isSessionSecret(csrfToken) {
            throw APIError.invalidConfiguration("The session CSRF token is invalid.")
        }
        self.sessionCookie = sessionCookie
        self.csrfToken = csrfToken

        // Disabling shared cookies and credentials keeps each server/account connection isolated.
        let config = (configuration?.copy() as? URLSessionConfiguration) ?? .ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 30
        self.transport = URLSession(configuration: config, delegate: RejectRedirects(), delegateQueue: nil)
    }

    public func conversation(conversation: String, limit: Int = 100, before: String? = nil) async throws -> ConversationSnapshot {
        try validatePage(conversation: conversation, limit: limit)
        if let before, !APIValidation.isCursor(before) { throw APIError.invalidInput("The conversation cursor is invalid.") }
        return try await request("/api/conversation", query: scoped(conversation, ["limit": String(limit), "before": before]))
    }

    public func sendChat(prompt: String, conversation: String, requestID: String) async throws -> ChatOperation {
        try validateConversation(conversation)
        guard APIValidation.isPrompt(prompt), APIValidation.isIdentifier(requestID) else {
            throw APIError.invalidInput("Provide a nonblank message up to 16,000 characters and a valid request ID.")
        }
        return try await request("/api/chat", method: "POST", body: ChatBody(prompt: prompt, conversation: conversation, requestId: requestID))
    }

    public func chatStatus(requestID: String, conversation: String) async throws -> ChatOperation {
        try validateChat(requestID: requestID, conversation: conversation)
        return try await request("/api/chat/\(requestID)", query: scoped(conversation))
    }

    public func stopChat(requestID: String, conversation: String) async throws -> ChatOperation {
        try validateChat(requestID: requestID, conversation: conversation)
        return try await request("/api/chat/\(requestID)", method: "DELETE", query: scoped(conversation))
    }

    public func workspace(conversation: String) async throws -> WorkspaceListing {
        try validateConversation(conversation)
        return try await request("/api/workspace", query: scoped(conversation))
    }

    public func file(path: String, conversation: String) async throws -> WorkspaceFile {
        try validateFile(path: path, conversation: conversation)
        let result: FileEnvelope = try await request("/api/workspace/file", query: scoped(conversation, ["path": path]))
        return result.file
    }

    public func saveFile(path: String, content: String, expectedRevision: Int?, conversation: String) async throws -> WorkspaceFile {
        try validateFile(path: path, conversation: conversation)
        guard APIValidation.isWorkspaceContent(content), expectedRevision.map(APIValidation.isRevision) ?? true else {
            throw APIError.invalidInput("Provide UTF-8 text up to 128 KB and the file’s current revision.")
        }
        let result: FileEnvelope = try await request("/api/workspace/file", method: "PUT",
            query: scoped(conversation, ["path": path]), body: SaveFileBody(content: content, expectedRevision: expectedRevision))
        return result.file
    }

    public func deleteFile(path: String, expectedRevision: Int, conversation: String) async throws {
        try validateFile(path: path, conversation: conversation)
        guard APIValidation.isRevision(expectedRevision) else { throw APIError.invalidInput("Provide the file’s current revision to delete it.") }
        let _: DeleteFileReceipt = try await request("/api/workspace/file", method: "DELETE",
            query: scoped(conversation, ["path": path]), body: RevisionBody(expectedRevision: expectedRevision))
    }

    public func captures(conversation: String, limit: Int = 25, before: Int? = nil) async throws -> CapturePage {
        try validatePage(conversation: conversation, limit: limit)
        if let before, !APIValidation.isRevision(before) { throw APIError.invalidInput("The capture cursor is invalid.") }
        return try await request("/api/notes", query: scoped(conversation, ["limit": String(limit), "before": before.map(String.init)]))
    }

    public func capture(id: String, conversation: String) async throws -> Capture {
        try validateConversation(conversation)
        guard APIValidation.isCaptureID(id) else { throw APIError.invalidInput("The capture ID is invalid.") }
        return try await request("/api/notes/\(id.lowercased())", query: scoped(conversation))
    }

    public func resources(conversation: String) async throws -> ResourceSnapshot {
        try validateConversation(conversation)
        return try await request("/api/resources", query: scoped(conversation))
    }

    /// Session bootstrap is always cookie-only, as bearer API tokens cannot manage accounts.
    public func session() async throws -> AuthSession {
        try await request("/api/auth/session", authentication: .session)
    }

    public func exchange(code: String, codeVerifier: String) async throws -> NativeSessionExchange {
        guard APIValidation.isSessionSecret(code), APIValidation.isCodeVerifier(codeVerifier) else {
            throw APIError.invalidInput("That sign-in link is invalid. Start GitHub sign-in again.")
        }
        return try await request("/api/auth/native/exchange", method: "POST", authentication: .none,
                                 body: NativeExchangeBody(code: code, codeVerifier: codeVerifier))
    }

    public func githubLoginURL(codeChallenge: String, conversation: String) throws -> URL {
        try validateConversation(conversation)
        guard APIValidation.isSessionSecret(codeChallenge) else { throw APIError.invalidInput("The sign-in challenge is invalid.") }
        return try url("/auth/github/login", query: ["client": "ios", "code_challenge": codeChallenge, "conversation": conversation])
    }

    public func listTokens() async throws -> [AccountToken] {
        try requireSession()
        let result: TokenEnvelope = try await request("/api/auth/tokens", authentication: .session)
        return result.tokens
    }

    public func createToken(name: String, scopes: [String] = ["read", "write"], expiresInDays: Int? = 90) async throws -> CreatedAccountToken {
        try requireSession()
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 80, scopes.contains("read"),
              Set(scopes).count == scopes.count, scopes.allSatisfy({ ["read", "write"].contains($0) }),
              expiresInDays.map({ [30, 90, 365].contains($0) }) ?? true else {
            throw APIError.invalidInput("Provide a name (1–80 characters), read or read/write scopes, and expiry of 30, 90, 365 days or no expiry.")
        }
        return try await request("/api/auth/tokens", method: "POST", authentication: .session,
                                 body: TokenBody(name: name, scopes: scopes, expiresInDays: expiresInDays))
    }

    public func revokeToken(id: String) async throws {
        try requireSession()
        guard APIValidation.isCaptureID(id) else { throw APIError.invalidInput("The token ID is invalid.") }
        let _: RevokeTokenReceipt = try await request("/api/auth/tokens/\(id)", method: "DELETE", authentication: .session)
    }

    public func logout() async throws {
        try requireSession()
        let _: AuthSession = try await request("/auth/logout", method: "POST", authentication: .session)
    }

    private enum Authentication { case api, session, none }

    private func request<T: Decodable>(_ path: String, method: String = "GET", query: [String: String?] = [:],
                                       authentication: Authentication = .api) async throws -> T {
        try await decode(makeRequest(path, method: method, query: query, authentication: authentication, body: nil))
    }

    private func request<T: Decodable, Body: Encodable>(_ path: String, method: String = "GET", query: [String: String?] = [:],
                                                       authentication: Authentication = .api, body: Body) async throws -> T {
        try await decode(makeRequest(path, method: method, query: query, authentication: authentication, body: JSONEncoder().encode(body)))
    }

    private func decode<T: Decodable>(_ request: URLRequest) async throws -> T {
        try Task.checkCancellation()
        let (data, response) = try await transport.data(for: request)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let detail = try? JSONDecoder().decode(ErrorBody.self, from: data)
            throw APIError.http(statusCode: response.statusCode,
                                message: detail?.error ?? "The request failed (\(response.statusCode)). Please try again.",
                                currentRevision: detail?.currentRevision)
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.invalidResponse }
    }

    private func makeRequest(_ path: String, method: String, query: [String: String?], authentication: Authentication,
                             body: Data?) throws -> URLRequest {
        var request = URLRequest(url: try url(path, query: query))
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if authentication == .api, let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        } else if authentication != .none, let sessionCookie {
            request.setValue("__Host-isobot_session=\(sessionCookie)", forHTTPHeaderField: "Cookie")
            if !["GET", "HEAD"].contains(method) {
                guard let csrfToken else { throw APIError.sessionRequired }
                request.setValue(csrfToken, forHTTPHeaderField: "X-CSRF-Token")
            }
        } else if authentication == .api { throw APIError.authenticationRequired }
        return request
    }

    private func url(_ path: String, query: [String: String?]) throws -> URL {
        guard path.hasPrefix("/"), !path.hasPrefix("//"),
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidConfiguration("Requests must stay on the configured agent origin.")
        }
        components.path = path
        components.queryItems = query.keys.sorted().compactMap { key in
            guard let value = query[key] ?? nil else { return nil }
            return URLQueryItem(name: key, value: value)
        }
        guard let result = components.url else { throw APIError.invalidConfiguration("The request URL is invalid.") }
        return result
    }

    private func scoped(_ conversation: String, _ values: [String: String?] = [:]) -> [String: String?] {
        values.merging(["conversation": conversation]) { _, new in new }
    }

    private func validateConversation(_ value: String) throws {
        guard APIValidation.isIdentifier(value) else { throw APIError.invalidInput("Use 1–100 letters, digits, underscores, or hyphens for the conversation name.") }
    }

    private func validatePage(conversation: String, limit: Int) throws {
        try validateConversation(conversation)
        guard (1...100).contains(limit) else { throw APIError.invalidInput("The page limit must be between 1 and 100.") }
    }

    private func validateChat(requestID: String, conversation: String) throws {
        try validateConversation(conversation)
        guard APIValidation.isIdentifier(requestID) else { throw APIError.invalidInput("The request ID is invalid.") }
    }

    private func validateFile(path: String, conversation: String) throws {
        try validateConversation(conversation)
        guard APIValidation.isWorkspacePath(path) else { throw APIError.invalidInput("Use a relative file path such as notes/ideas.md without empty folders, dot segments, colons, or surrounding spaces.") }
    }

    private func requireSession() throws {
        guard sessionCookie != nil else { throw APIError.sessionRequired }
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private struct ChatBody: Encodable { let prompt: String; let conversation: String; let requestId: String }
private struct FileEnvelope: Decodable { let file: WorkspaceFile }
private struct DeleteFileReceipt: Decodable { let deleted: Bool; let path: String }
private struct RevisionBody: Encodable { let expectedRevision: Int }
private struct NativeExchangeBody: Encodable { let code: String; let codeVerifier: String }
private struct TokenEnvelope: Decodable { let tokens: [AccountToken] }
private struct RevokeTokenReceipt: Decodable { let id: String; let revoked: Bool }
private struct ErrorBody: Decodable { let error: String; let currentRevision: Int? }

private struct SaveFileBody: Encodable {
    let content: String
    let expectedRevision: Int?
    private enum CodingKeys: String, CodingKey { case content, expectedRevision }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(content, forKey: .content)
        if let expectedRevision { try container.encode(expectedRevision, forKey: .expectedRevision) }
        else { try container.encodeNil(forKey: .expectedRevision) }
    }
}

private struct TokenBody: Encodable {
    let name: String
    let scopes: [String]
    let expiresInDays: Int?
    private enum CodingKeys: String, CodingKey { case name, scopes, expiresInDays }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(scopes, forKey: .scopes)
        if let expiresInDays { try container.encode(expiresInDays, forKey: .expiresInDays) }
        else { try container.encodeNil(forKey: .expiresInDays) }
    }
}
