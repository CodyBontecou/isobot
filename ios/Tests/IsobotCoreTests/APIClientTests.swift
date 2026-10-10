import XCTest
@testable import IsobotCore

private final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class APIClientTests: XCTestCase {
    private let credential = String(repeating: "a", count: 43)
    private let csrf = String(repeating: "b", count: 43)

    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    private func client(bearer: String? = nil, cookie: String? = nil, csrf: String? = nil) throws -> IsobotAPIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return try IsobotAPIClient(origin: URL(string: "https://agent.example.com/")!, bearerToken: bearer,
                                   sessionCookie: cookie, csrfToken: csrf, configuration: config)
    }

    private func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testBearerConversationRequestsStayScopedAndDoNotSendCookies() async throws {
        let client = try client(bearer: "Bearer test-token", cookie: credential, csrf: csrf)
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.host, "agent.example.com")
            XCTAssertEqual(request.url?.path, "/api/conversation")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            XCTAssertEqual(query.filter { $0.name == "conversation" }.map(\.value), ["research"])
            XCTAssertEqual(query.first { $0.name == "before" }?.value, "123")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertFalse(request.httpShouldHandleCookies)
            return (200, Data(#"{"model":"test","busy":false,"pending":[],"entries":[]}"#.utf8))
        }
        _ = try await client.conversation(conversation: "research", before: "123")
    }

    func testSessionFileCreationSendsOriginCSRFAndExplicitNullRevision() async throws {
        let client = try client(cookie: credential, csrf: csrf)
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "__Host-isobot_session=\(self.credential)")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://agent.example.com")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-CSRF-Token"), self.csrf)
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            XCTAssertEqual(query.first { $0.name == "path" }?.value, "notes/café & ideas.md")
            let body = try self.jsonBody(request)
            XCTAssertTrue(body["expectedRevision"] is NSNull)
            XCTAssertEqual(body["content"] as? String, "# Idea")
            return (201, Data(##"{"conversation":"vox","file":{"path":"notes/café & ideas.md","bytes":6,"revision":1,"updatedAt":"2026-10-07T12:01:00Z","content":"# Idea"}}"##.utf8))
        }
        let file = try await client.saveFile(path: "notes/café & ideas.md", content: "# Idea", expectedRevision: nil, conversation: "vox")
        XCTAssertEqual(file.revision, 1)
    }

    func testRetryUsesOriginalChatRequestID() async throws {
        let client = try client(bearer: "test")
        MockURLProtocol.handler = { request in
            let body = try self.jsonBody(request)
            XCTAssertEqual(body["requestId"] as? String, "stable-request")
            XCTAssertEqual(body["conversation"] as? String, "vox")
            XCTAssertEqual(body["prompt"] as? String, "hello")
            return (202, Data(#"{"conversation":"vox","requestId":"stable-request","operationId":"stable-request","status":"queued","accepted":true}"#.utf8))
        }
        for _ in 0..<2 { _ = try await client.sendChat(prompt: "hello", conversation: "vox", requestID: "stable-request") }
    }

    func testConflictExposesCurrentRevision() async throws {
        let client = try client(bearer: "test")
        MockURLProtocol.handler = { _ in
            (409, Data(#"{"error":"File changed since it was opened","currentRevision":12}"#.utf8))
        }
        do {
            _ = try await client.saveFile(path: "notes.md", content: "new", expectedRevision: 9, conversation: "vox")
            XCTFail("Expected revision conflict")
        } catch let error as APIError {
            XCTAssertTrue(error.isConflict)
            XCTAssertEqual(error.currentRevision, 12)
            XCTAssertEqual(error.localizedDescription, "File changed since it was opened")
        }
    }

    func testNativeExchangeDoesNotSendExistingCredentials() async throws {
        let client = try client(bearer: "test", cookie: credential, csrf: csrf)
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/auth/native/exchange")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://agent.example.com")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            let body = try self.jsonBody(request)
            XCTAssertEqual(body["codeVerifier"] as? String, self.csrf)
            return (200, Data("{\"credential\":\"\(self.credential)\",\"csrfToken\":\"\(self.csrf)\",\"user\":{\"id\":\"1\",\"login\":\"cody\"},\"expiresAt\":\"2026-10-14T12:00:00.000Z\"}".utf8))
        }
        let result = try await client.exchange(code: credential, codeVerifier: csrf)
        XCTAssertEqual(result.user.login, "cody")
    }

    func testAccountTokenNoExpiryUsesExplicitNullAndCookieOnly() async throws {
        let client = try client(bearer: "test", cookie: credential, csrf: csrf)
        MockURLProtocol.handler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-CSRF-Token"), self.csrf)
            XCTAssertTrue(try self.jsonBody(request)["expiresInDays"] is NSNull)
            return (201, Data(#"{"token":"isobot_pat_once","id":"b5a1c01a-6b83-4d21-b973-9102848bb683","name":"Phone","prefix":"isobot_pat_a…1234","scopes":["read"],"createdAt":"2026-10-07T12:01:00Z","expiresAt":null,"lastUsedAt":null,"revokedAt":null}"#.utf8))
        }
        let result = try await client.createToken(name: "Phone", scopes: ["read"], expiresInDays: nil)
        XCTAssertEqual(result.token, "isobot_pat_once")
    }

    func testSessionBootstrapDoesNotUseBearerToken() async throws {
        let client = try client(bearer: "test")
        MockURLProtocol.handler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return (200, Data(#"{"authenticated":false,"oauthConfigured":true}"#.utf8))
        }
        let session = try await client.session()
        XCTAssertFalse(session.authenticated)
    }

    func testInvalidOriginAndCredentialsRejectedBeforeRequest() {
        for origin in ["http://agent.example.com", "https://user:pass@agent.example.com", "https://agent.example.com/console", "https://agent.example.com?token=bad", "https://agent.example.com#fragment"] {
            XCTAssertThrowsError(try IsobotAPIClient(origin: URL(string: origin)!))
        }
        XCTAssertNoThrow(try IsobotAPIClient(origin: URL(string: "http://localhost:8787")!))
        XCTAssertEqual(try? IsobotAPIClient(origin: URL(string: "https://agent.example.com:443/")!).origin.absoluteString,
                       "https://agent.example.com")
        XCTAssertThrowsError(try client(cookie: "bad; injection=value"))
        XCTAssertThrowsError(try client(cookie: credential + "\n"))
    }

    func testMissingSessionCSRFRejectsMutationBeforeTransport() async throws {
        let client = try client(cookie: credential)
        MockURLProtocol.handler = { _ in XCTFail("Must reject mutation before sending"); return (500, Data()) }
        do {
            _ = try await client.sendChat(prompt: "hello", conversation: "vox", requestID: "request")
            XCTFail("Expected missing CSRF error")
        } catch let error as APIError {
            guard case .sessionRequired = error else { return XCTFail("Unexpected error") }
        }
    }
}
