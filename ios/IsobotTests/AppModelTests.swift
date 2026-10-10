import XCTest
@testable import Isobot

/// Each client gets its own origin and handler. Requests never reach a real server.
private final class AppModelURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var handlers: [String: (AppModelURLProtocol) -> Void] = [:]

    static func register(host: String, handler: @escaping (AppModelURLProtocol) -> Void) {
        lock.lock()
        handlers[host] = handler
        lock.unlock()
    }

    static func unregister(host: String) {
        lock.lock()
        handlers.removeValue(forKey: host)
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let handler = Self.handlers[request.url?.host ?? ""]
        Self.lock.unlock()
        guard let handler else {
            fail(URLError(.unsupportedURL))
            return
        }
        handler(self)
    }

    override func stopLoading() {}

    func respond(_ body: [String: Any], status: Int = 200) {
        do {
            let data = try JSONSerialization.data(withJSONObject: body)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { fail(error) }
    }

    func fail(_ error: Error) { client?.urlProtocol(self, didFailWithError: error) }

    func query(_ name: String) -> String? {
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == name })?.value
    }

    func body() throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

/// URLProtocol callbacks arrive on a URLSession queue, while assertions run on MainActor.
private final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value
    init(_ value: Value) { self.value = value }
    func read() -> Value {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
    @discardableResult func update<Result>(_ body: (inout Value) -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

final class AppModelTests: XCTestCase {
    private var registeredHosts: [String] = []
    private var defaultsSuites: [String] = []

    override func tearDown() {
        for host in registeredHosts { AppModelURLProtocol.unregister(host: host) }
        for suite in defaultsSuites { UserDefaults.standard.removePersistentDomain(forName: suite) }
        registeredHosts = []
        defaultsSuites = []
        super.tearDown()
    }

    private func defaults() throws -> UserDefaults {
        let suite = "Isobot.AppModelTests.\(UUID().uuidString)"
        defaultsSuites.append(suite)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("vox", forKey: "conversation")
        defaults.set(["vox", "default"], forKey: "conversations")
        return defaults
    }

    private func client(_ handler: @escaping (AppModelURLProtocol) -> Void) throws -> IsobotAPIClient {
        let host = "\(UUID().uuidString.lowercased()).isobot.test"
        registeredHosts.append(host)
        AppModelURLProtocol.register(host: host, handler: handler)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AppModelURLProtocol.self]
        return try IsobotAPIClient(origin: URL(string: "https://\(host)")!, bearerToken: "synthetic-test-token", configuration: config)
    }

    private static func entry(_ id: String, text: String = "Message") -> [String: Any] {
        ["id": id, "role": "assistant", "text": text]
    }

    private static func snapshot(conversation: String = "vox", entries: [[String: Any]] = [],
                                 pending: [String] = [], nextCursor: String? = nil) -> [String: Any] {
        ["conversation": conversation, "model": "test", "busy": !pending.isEmpty,
         "pending": pending.map { ["operationId": $0, "status": "queued"] },
         "entries": entries, "nextCursor": nextCursor.map { $0 as Any } ?? NSNull()]
    }

    private static func operation(_ id: String, status: String, conversation: String = "vox") -> [String: Any] {
        ["conversation": conversation, "requestId": id, "operationId": id, "status": status,
         "accepted": status == "queued", "reason": status == "unanswered" ? "Request stopped" : ""]
    }

    @MainActor
    func testConversationSwitchKeepsDraftsIsolatedAndPersistsSelection() throws {
        let defaults = try defaults()
        let api = try client { request in
            request.respond(Self.snapshot(conversation: request.query("conversation") ?? "vox"))
        }
        let model = AppModel(client: api, defaults: defaults)
        let firstConnection = model.connectionID
        model.draft = "A draft for Vox"
        try model.selectConversation("research")
        XCTAssertEqual(model.draft, "")
        XCTAssertNotEqual(model.connectionID, firstConnection)
        XCTAssertTrue(model.conversations.contains("research"))
        model.draft = "A research draft"
        try model.selectConversation("vox")
        XCTAssertEqual(model.draft, "A draft for Vox")
        try model.selectConversation("research")
        XCTAssertEqual(model.draft, "A research draft")
        XCTAssertEqual(defaults.string(forKey: "conversation"), "research")
        XCTAssertThrowsError(try model.selectConversation("../invalid"))
        XCTAssertEqual(model.conversation, "research")
        XCTAssertEqual(model.draft, "A research draft")
    }

    @MainActor
    func testPreviewConnectionDoesNotChangeSavedPreferences() async throws {
        let defaults = try defaults()
        let suite = try XCTUnwrap(defaultsSuites.last)
        defaults.set("https://saved.isobot.test", forKey: "serverOrigin")
        defaults.set("saved", forKey: "conversation")
        defaults.set(["saved", "vox"], forKey: "conversations")
        let saved = NSDictionary(dictionary: try XCTUnwrap(defaults.persistentDomain(forName: suite)))

        let model = AppModel(client: try PreviewServer.makeClient(), user: PreviewServer.user, defaults: defaults)
        XCTAssertNotNil(model.api)
        XCTAssertEqual(NSDictionary(dictionary: try XCTUnwrap(defaults.persistentDomain(forName: suite))), saved)

        model.draft = "Preview draft"
        try model.selectConversation("research")
        XCTAssertEqual(model.conversation, "research")
        XCTAssertEqual(NSDictionary(dictionary: try XCTUnwrap(defaults.persistentDomain(forName: suite))), saved)

        await model.disconnect()
        XCTAssertNil(model.api)
        XCTAssertEqual(NSDictionary(dictionary: try XCTUnwrap(defaults.persistentDomain(forName: suite))), saved)
    }

    @MainActor
    func testPaginationDeduplicatesOverlappingPagesAndRefreshPreservesOlderHistory() async throws {
        let reads = LockedValue(0)
        let api = try client { request in
            if request.query("before") == "2" {
                request.respond(Self.snapshot(entries: [Self.entry("1"), Self.entry("2"), Self.entry("3", text: "Duplicate older copy")]))
            } else {
                let read = reads.update { $0 += 1; return $0 }
                request.respond(read == 1
                    ? Self.snapshot(entries: [Self.entry("3", text: "Original third message"), Self.entry("4")], nextCursor: "2")
                    : Self.snapshot(entries: [Self.entry("4", text: "Updated fourth message"), Self.entry("5")]))
            }
        }
        let model = AppModel(client: api, defaults: try defaults())
        await model.refresh(initial: true)
        XCTAssertEqual(model.snapshot.entries.map(\.id), ["3", "4"])
        await model.loadOlder()
        XCTAssertEqual(model.snapshot.entries.map(\.id), ["1", "2", "3", "4"])
        XCTAssertEqual(model.snapshot.entries.first(where: { $0.id == "3" })?.text, "Original third message")
        XCTAssertNil(model.snapshot.nextCursor)
        await model.refresh()
        XCTAssertEqual(model.snapshot.entries.map(\.id), ["1", "2", "3", "4", "5"])
        XCTAssertEqual(model.snapshot.entries.first(where: { $0.id == "4" })?.text, "Updated fourth message")
        XCTAssertFalse(model.loadingOlder)
    }

    @MainActor
    func testAmbiguousSendFailureRetriesTheSameUUID() async throws {
        let requests = LockedValue<[String]>([])
        let api = try client { request in
            if request.request.httpMethod == "POST" {
                do {
                    let input = try request.body()
                    let id = try XCTUnwrap(input["requestId"] as? String)
                    XCTAssertEqual(input["prompt"] as? String, "One durable request")
                    let attempt = requests.update { $0.append(id); return $0.count }
                    if attempt == 1 { request.fail(URLError(.networkConnectionLost)) }
                    else { request.respond(Self.operation(id, status: "queued"), status: 202) }
                } catch { request.fail(error) }
            } else {
                request.respond(Self.snapshot(pending: requests.read().last.map { [$0] } ?? []))
            }
        }
        let model = AppModel(client: api, defaults: try defaults())
        model.draft = "One durable request"
        await model.send()
        let failed = try XCTUnwrap(model.jobs.first)
        XCTAssertNotNil(UUID(uuidString: failed.id))
        XCTAssertFalse(failed.pending)
        XCTAssertFalse(failed.terminal)
        XCTAssertNotNil(failed.error)
        await model.retry(failed)
        XCTAssertEqual(requests.read(), [failed.id, failed.id])
        XCTAssertEqual(model.jobs.count, 1)
        XCTAssertEqual(model.jobs.first?.id, failed.id)
        XCTAssertTrue(model.jobs.first?.pending == true)
        XCTAssertNil(model.jobs.first?.error)
    }

    @MainActor
    func testRetryAfterTerminalFailureCreatesANewUUID() async throws {
        let requests = LockedValue<[String]>([])
        let api = try client { request in
            if request.request.httpMethod == "POST" {
                do {
                    let id = try XCTUnwrap(try request.body()["requestId"] as? String)
                    let attempt = requests.update { $0.append(id); return $0.count }
                    request.respond(Self.operation(id, status: attempt == 1 ? "unanswered" : "queued"), status: 202)
                } catch { request.fail(error) }
            } else { request.respond(Self.snapshot()) }
        }
        let model = AppModel(client: api, defaults: try defaults())
        model.draft = "Try this again"
        await model.send()
        let failed = try XCTUnwrap(model.jobs.first)
        XCTAssertTrue(failed.terminal)
        XCTAssertFalse(failed.pending)
        await model.retry(failed)
        let retried = try XCTUnwrap(model.jobs.first)
        XCTAssertNotEqual(retried.id, failed.id)
        XCTAssertNotNil(UUID(uuidString: retried.id))
        XCTAssertEqual(retried.prompt, failed.prompt)
        XCTAssertEqual(requests.read(), [failed.id, retried.id])
        XCTAssertEqual(model.jobs.count, 1)
    }

    @MainActor
    func testSwitchingConversationWhileRefreshIsPendingRejectsTheOldResponse() async throws {
        let started = expectation(description: "Vox refresh started")
        let held = LockedValue<AppModelURLProtocol?>(nil)
        let api = try client { request in
            if request.query("conversation") == "vox" {
                held.update { $0 = request }
                started.fulfill()
            } else { request.respond(Self.snapshot(conversation: "research", entries: [Self.entry("88", text: "Research history")])) }
        }
        let model = AppModel(client: api, defaults: try defaults())
        let refresh = Task { await model.refresh(initial: true) }
        await fulfillment(of: [started], timeout: 2)
        try model.selectConversation("research")
        await model.refresh(initial: true)
        try XCTUnwrap(held.read()).respond(Self.snapshot(entries: [Self.entry("99", text: "Stale Vox history")], pending: ["old-request"]))
        await refresh.value
        XCTAssertEqual(model.conversation, "research")
        XCTAssertEqual(model.snapshot.entries.map(\.id), ["88"])
        XCTAssertFalse(model.busy)
        XCTAssertFalse(model.loading)
        XCTAssertNil(model.error)
    }

    @MainActor
    func testSupersededRefreshCannotReplaceTheNewerSnapshot() async throws {
        let started = expectation(description: "First refresh started")
        let reads = LockedValue(0)
        let held = LockedValue<AppModelURLProtocol?>(nil)
        let api = try client { request in
            let read = reads.update { $0 += 1; return $0 }
            if read == 1 {
                held.update { $0 = request }
                started.fulfill()
            } else { request.respond(Self.snapshot(entries: [Self.entry("2", text: "Newer history")])) }
        }
        let model = AppModel(client: api, defaults: try defaults())
        let refresh = Task { await model.refresh(initial: true) }
        await fulfillment(of: [started], timeout: 2)
        await model.refresh()
        try XCTUnwrap(held.read()).respond(Self.snapshot(entries: [Self.entry("1", text: "Outdated history")]))
        await refresh.value
        XCTAssertEqual(model.snapshot.entries.map(\.id), ["2"])
        XCTAssertFalse(model.loading)
    }

    @MainActor
    func testUnauthorizedCurrentConnectionDisconnectsAndClearsPrivateState() async throws {
        let api = try client { $0.respond(["error": "Session expired"], status: 401) }
        let model = AppModel(client: api, user: PreviewServer.user, defaults: try defaults())
        let initialConnection = model.connectionID
        model.draft = "Private draft"
        await model.refresh(initial: true)
        XCTAssertNil(model.api)
        XCTAssertNil(model.user)
        XCTAssertFalse(model.isSession)
        XCTAssertNotEqual(model.connectionID, initialConnection)
        XCTAssertEqual(model.draft, "")
        XCTAssertTrue(model.snapshot.entries.isEmpty)
        XCTAssertTrue(model.jobs.isEmpty)
        XCTAssertEqual(model.error, "Your connection expired. Sign in again to continue.")
    }

    @MainActor
    func testUnauthorizedOldConversationDoesNotDisconnectTheCurrentConnection() async throws {
        let started = expectation(description: "Old conversation refresh started")
        let held = LockedValue<AppModelURLProtocol?>(nil)
        let api = try client { request in
            if request.query("conversation") == "vox" {
                held.update { $0 = request }
                started.fulfill()
            } else { request.respond(Self.snapshot(conversation: "research", entries: [Self.entry("3")])) }
        }
        let model = AppModel(client: api, defaults: try defaults())
        let refresh = Task { await model.refresh() }
        await fulfillment(of: [started], timeout: 2)
        try model.selectConversation("research")
        await model.refresh()
        try XCTUnwrap(held.read()).respond(["error": "Old request expired"], status: 401)
        await refresh.value
        XCTAssertNotNil(model.api)
        XCTAssertEqual(model.snapshot.entries.map(\.id), ["3"])
        XCTAssertNil(model.error)
    }

    @MainActor
    func testStopDoesNotSendRemainingOldJobsToANewConversationAfterAnError() async throws {
        let started = expectation(description: "First stop request started")
        let deletes = LockedValue<[String]>([])
        let held = LockedValue<AppModelURLProtocol?>(nil)
        let api = try client { request in
            if request.request.httpMethod == "DELETE" {
                let count = deletes.update { $0.append(request.query("conversation") ?? ""); return $0.count }
                if count == 1 {
                    held.update { $0 = request }
                    started.fulfill()
                } else {
                    request.respond(Self.operation(request.request.url!.lastPathComponent, status: "unanswered", conversation: "research"))
                }
            } else {
                request.respond(Self.snapshot(pending: request.query("conversation") == "vox" ? ["first-request", "second-request"] : []))
            }
        }
        let model = AppModel(client: api, defaults: try defaults())
        await model.refresh()
        let stop = Task { await model.stop() }
        await fulfillment(of: [started], timeout: 2)
        try model.selectConversation("research")
        try XCTUnwrap(held.read()).fail(URLError(.networkConnectionLost))
        await stop.value
        XCTAssertEqual(deletes.read(), ["vox"])
        XCTAssertFalse(model.stopping)
        XCTAssertNil(model.error)
    }
}
