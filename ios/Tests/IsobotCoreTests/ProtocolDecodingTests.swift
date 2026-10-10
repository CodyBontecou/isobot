import XCTest
@testable import IsobotCore

final class ProtocolDecodingTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testConversationCursorAndToolEntries() throws {
        let snapshot = try decoder.decode(ConversationSnapshot.self, from: Data(#"""
        {"conversation":"vox","model":"kimi","busy":true,"pending":[{"operationId":"request-1","status":"running"}],
         "entries":[{"id":"9","role":"assistant","text":"Checking","createdAt":"2026-10-07T12:01:00.000Z",
             "toolCalls":[{"id":"tool-1","name":"read_file","arguments":"{\"path\":\"notes.md\"}"}]},
             {"id":"10","role":"tool","text":"missing","toolResult":{"name":"read_file","id":"tool-1","error":true}},
             {"id":"11","role":"system","text":"Conversation reset."}],"nextCursor":"9"}
        """#.utf8))
        XCTAssertEqual(snapshot.nextCursor, "9")
        XCTAssertEqual(snapshot.pending.first?.id, "request-1")
        XCTAssertEqual(snapshot.entries[0].toolCalls?.first?.arguments, #"{"path":"notes.md"}"#)
        XCTAssertEqual(snapshot.entries[1].toolResult?.error, true)
        XCTAssertEqual(snapshot.entries[2].role, .system)
    }

    func testQueuedReceiptAndTerminalCancellationHaveDifferentOptionalFields() throws {
        let receipt = try decoder.decode(ChatOperation.self, from: Data(#"{"conversation":"vox","requestId":"req-1","operationId":"req-1","accepted":true,"status":"queued","statusUrl":"https://agent.example.com/api/chat/req-1?conversation=vox"}"#.utf8))
        XCTAssertFalse(receipt.isTerminal)
        XCTAssertEqual(receipt.accepted, true)
        XCTAssertNil(receipt.cancelled)
        let cancelled = try decoder.decode(ChatOperation.self, from: Data(#"{"conversation":"vox","requestId":"req-1","operationId":"req-1","status":"unanswered","text":"","reason":"Request aborted","cancelled":true}"#.utf8))
        XCTAssertTrue(cancelled.isTerminal)
        XCTAssertEqual(cancelled.cancelled, true)
        XCTAssertNil(cancelled.accepted)
    }

    func testWorkspaceListingDoesNotRequireFileContents() throws {
        let listing = try decoder.decode(WorkspaceListing.self, from: Data(#"{"conversation":"vox","files":[{"path":"notes/ideas.md","bytes":12,"revision":9,"updatedAt":"2026-10-07T12:01:00Z"}],"totalBytes":12,"maxFileBytes":131072,"maxFiles":500,"maxBytes":33554432}"#.utf8))
        XCTAssertEqual(listing.files.first?.revision, 9)
        XCTAssertNil(listing.files.first?.content)
        XCTAssertEqual(listing.maxBytes, 33_554_432)
    }

    func testCaptureListingAndDetailKeepJSONMetadata() throws {
        let page = try decoder.decode(CapturePage.self, from: Data(#"{"conversation":"vox","items":[{"sequence":6,"id":"b5a1c01a-6b83-4d21-b973-9102848bb683","mode":"memory","receivedAt":"2026-10-07T12:01:00Z","preview":"Idea","status":"stored"}],"nextCursor":6}"#.utf8))
        XCTAssertEqual(page.nextCursor, 6)
        XCTAssertNil(page.items.first?.markdown)
        let capture = try decoder.decode(Capture.self, from: Data(##"{"conversation":"vox","sequence":6,"id":"b5a1c01a-6b83-4d21-b973-9102848bb683","mode":"prompt","receivedAt":"2026-10-07T12:01:00Z","markdown":"# Idea","status":"done","operationId":"vox:uuid","result":{"operationId":"vox:uuid","status":"done","text":"Saved"},"payload":{"nested":[true,null,3.5,{"name":"note"}]}}"##.utf8))
        XCTAssertEqual(capture.result?.text, "Saved")
        XCTAssertEqual(capture.payload, .object(["nested": .array([.bool(true), .null, .number(3.5), .object(["name": .string("note")])])]))
        let encoded = try JSONEncoder().encode(capture.payload)
        XCTAssertEqual(try decoder.decode(JSONValue.self, from: encoded), capture.payload)
    }

    func testSessionAcceptsStringAndNumericGitHubIDsAndNullableName() throws {
        for id in [#""1234""#, "1234"] {
            let session = try decoder.decode(AuthSession.self, from: Data("{\"authenticated\":true,\"csrfToken\":\"secret\",\"user\":{\"id\":\(id),\"login\":\"cody\",\"name\":null}}".utf8))
            XCTAssertEqual(session.user?.id, "1234")
            XCTAssertNil(session.user?.name)
        }
        let signedOut = try decoder.decode(AuthSession.self, from: Data(#"{"authenticated":false,"oauthConfigured":true}"#.utf8))
        XCTAssertFalse(signedOut.authenticated)
        XCTAssertNil(signedOut.user)
    }

    func testTokenCreationUsesFlatMetadataAndNullableDates() throws {
        let created = try decoder.decode(CreatedAccountToken.self, from: Data(#"{"token":"isobot_pat_test","id":"b5a1c01a-6b83-4d21-b973-9102848bb683","name":"Phone","prefix":"isobot_pat_a…1234","scopes":["read","write"],"createdAt":"2026-10-07T12:01:00Z","expiresAt":null,"lastUsedAt":null,"revokedAt":null}"#.utf8))
        XCTAssertEqual(created.token, "isobot_pat_test")
        XCTAssertEqual(created.metadata.name, "Phone")
        XCTAssertNil(created.metadata.expiresAt)
    }

    func testResourceNumbersRetainModelBreakdownAndPriceSources() throws {
        let resources = try decoder.decode(ResourceSnapshot.self, from: Data(#"""
        {"conversation":"vox","runtime":{"model":"gpt-test","provider":"chatgpt","harness":"PiHarness","busy":false,"pendingCount":0,"sessionCount":1},
         "storage":{"databaseBytes":1000,"workspaceFiles":1,"workspaceBytes":100,"captures":2},
         "usage":{"scope":"assistant lifetime","inputTokens":123,"outputTokens":45,"cacheReadTokens":5,"cacheWriteTokens":0,"totalTokens":173,"recordedCatalogEstimateUSD":0.001,
           "models":[{"key":"gpt-test","inputTokens":123,"outputTokens":45,"cacheReadTokens":5,"cacheWriteTokens":0,"totalTokens":173,"recordedCatalogEstimateUSD":0.001}]},
         "bindings":[{"name":"Assistant","kind":"Durable Object","description":"Storage"}],
         "pricing":{"currency":"USD","checkedAt":"2026-10-07","actualBill":null,"model":{"source":"https://chatgpt.com/#settings/Account","label":"ChatGPT subscription; billed usage unavailable here"},
           "rates":[{"label":"SQLite storage","unit":"GB-month","usd":0.20,"source":"https://developers.cloudflare.com/durable-objects/platform/pricing/"}],
           "storageEstimateUSDPerMonth":0.0000002,"notes":["Not a bill"]}}
        """#.utf8))
        XCTAssertEqual(resources.usage.models.first?.inputTokens, 123)
        XCTAssertNil(resources.pricing.model.inputPerMillion)
        XCTAssertEqual(resources.pricing.rates.first?.usd, 0.2)
        XCTAssertNil(resources.pricing.actualBill)
    }

    func testValidationUsesServerUTF16PromptAndUTF8FileLimits() {
        XCTAssertTrue(APIValidation.isPrompt(String(repeating: "💡", count: 8_000)))
        XCTAssertFalse(APIValidation.isPrompt(String(repeating: "💡", count: 8_001)))
        XCTAssertFalse(APIValidation.isPrompt(" \n\t"))
        XCTAssertTrue(APIValidation.isWorkspacePath("notes/café.md"))
        for path in ["../secret", "/file.md", "notes//file.md", "notes/../file.md", "file:md", " notes.md", "notes.md\u{7f}"] {
            XCTAssertFalse(APIValidation.isWorkspacePath(path), path)
        }
        XCTAssertFalse(APIValidation.isWorkspaceContent("binary\0file"))
        XCTAssertFalse(APIValidation.isWorkspaceContent(String(repeating: "💡", count: 32_769)))
        XCTAssertFalse(APIValidation.isCursor("9007199254740992"))
        XCTAssertFalse(APIValidation.isIdentifier("vox\n"))
        XCTAssertFalse(APIValidation.isSessionSecret(String(repeating: "a", count: 43) + "\n"))
    }
}
