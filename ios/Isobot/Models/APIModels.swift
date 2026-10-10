import Foundation

public enum MessageRole: String, Codable, Sendable {
    case user, assistant, tool, system
}

public struct ToolCall: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let arguments: String
}

public struct ToolResult: Codable, Equatable, Sendable {
    public let name: String
    public let id: String
    public let error: Bool
}

public struct ConversationEntry: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let role: MessageRole
    public let text: String
    public let createdAt: String?
    public let toolCalls: [ToolCall]?
    public let toolResult: ToolResult?

    public init(id: String, role: MessageRole, text: String, createdAt: String? = nil,
                toolCalls: [ToolCall]? = nil, toolResult: ToolResult? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.toolCalls = toolCalls
        self.toolResult = toolResult
    }
}

public struct PendingOperation: Codable, Equatable, Identifiable, Sendable {
    public let operationId: String
    public let status: String
    public var id: String { operationId }
}

public struct ConversationSnapshot: Codable, Equatable, Sendable {
    public let conversation: String?
    public let model: String
    public let busy: Bool
    public let pending: [PendingOperation]
    public let entries: [ConversationEntry]
    public let nextCursor: String?

    public init(conversation: String? = nil, model: String = "", busy: Bool = false,
                pending: [PendingOperation] = [], entries: [ConversationEntry] = [], nextCursor: String? = nil) {
        self.conversation = conversation
        self.model = model
        self.busy = busy
        self.pending = pending
        self.entries = entries
        self.nextCursor = nextCursor
    }
}

public enum ChatStatus: String, Codable, Sendable {
    case queued, running, done, unanswered
    public var isTerminal: Bool { self == .done || self == .unanswered }
}

/// POST receipts and later GET/DELETE operation results share the same public fields.
public struct ChatOperation: Codable, Equatable, Sendable {
    public let conversation: String
    public let requestId: String
    public let operationId: String
    public let status: ChatStatus
    public let text: String?
    public let reason: String?
    public let accepted: Bool?
    public let cancelled: Bool?
    public let statusUrl: String?
    public var isTerminal: Bool { status.isTerminal }
}

public struct WorkspaceFile: Codable, Equatable, Identifiable, Sendable {
    public let path: String
    public let bytes: Int
    public let revision: Int
    public let updatedAt: String
    public let content: String?
    public var id: String { path }

    public init(path: String, bytes: Int = 0, revision: Int = 0, updatedAt: String = "", content: String? = nil) {
        self.path = path
        self.bytes = bytes
        self.revision = revision
        self.updatedAt = updatedAt
        self.content = content
    }
}

public struct WorkspaceListing: Codable, Equatable, Sendable {
    public let conversation: String?
    public let files: [WorkspaceFile]
    public let totalBytes: Int
    public let maxFileBytes: Int
    public let maxFiles: Int
    public let maxBytes: Int
}

public enum CaptureMode: String, Codable, Sendable {
    case memory, prompt
}

public struct CaptureResult: Codable, Equatable, Sendable {
    public let operationId: String?
    public let status: String
    public let text: String?
    public let reason: String?
}

/// The listing returns previews; the detail route adds Markdown, source JSON, and a result.
public struct Capture: Codable, Equatable, Identifiable, Sendable {
    public let conversation: String?
    public let sequence: Int
    public let id: String
    public let mode: CaptureMode
    public let receivedAt: String
    public let preview: String?
    public let status: String?
    public let markdown: String?
    public let payload: JSONValue?
    public let result: CaptureResult?
    public let operationId: String?
}

public struct CapturePage: Codable, Equatable, Sendable {
    public let conversation: String?
    public let items: [Capture]
    public let nextCursor: Int?
}

/// Keeps arbitrary capture source metadata intact, including nested arrays and null values.
public enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), array([JSONValue]), object([String: JSONValue]), null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    public var prettyPrinted: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "null"
    }

    public var prettyPrintedJSON: String { prettyPrinted }
}

public struct ResourceSnapshot: Codable, Equatable, Sendable {
    public let conversation: String?
    public let runtime: ResourceRuntime
    public let storage: ResourceStorage
    public let usage: ResourceUsage
    public let bindings: [ResourceBinding]
    public let pricing: ResourcePricing
}

public struct ResourceRuntime: Codable, Equatable, Sendable {
    public let model: String
    public let provider: String
    public let harness: String
    public let busy: Bool
    public let pendingCount: Int
    public let sessionCount: Int
}

public struct ResourceStorage: Codable, Equatable, Sendable {
    public let databaseBytes: Int
    public let workspaceFiles: Int
    public let workspaceBytes: Int
    public let captures: Int
}

public struct ResourceUsage: Codable, Equatable, Sendable {
    public let scope: String
    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheReadTokens: Int
    public let cacheWriteTokens: Int
    public let totalTokens: Int
    public let recordedCatalogEstimateUSD: Double
    public let models: [ResourceModelUsage]
}

public struct ResourceModelUsage: Codable, Equatable, Identifiable, Sendable {
    public let key: String
    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheReadTokens: Int
    public let cacheWriteTokens: Int
    public let totalTokens: Int
    public let recordedCatalogEstimateUSD: Double
    public var id: String { key }
}

public struct ResourceBinding: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let kind: String
    public let description: String
    public var id: String { name }
}

public struct ResourcePricing: Codable, Equatable, Sendable {
    public let currency: String
    public let checkedAt: String
    public let actualBill: JSONValue?
    public let model: ResourceModelPricing
    public let rates: [ResourceRate]
    public let storageEstimateUSDPerMonth: Double
    public let notes: [String]
}

public struct ResourceModelPricing: Codable, Equatable, Sendable {
    public let source: String
    public let label: String
    public let inputPerMillion: Double?
    public let outputPerMillion: Double?
    public let cachedInputPerMillion: Double?
}

public struct ResourceRate: Codable, Equatable, Sendable {
    public let label: String
    public let unit: String
    public let usd: Double
    public let included: String?
    public let source: String
}

public struct AccountUser: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let login: String
    public let name: String?

    public init(id: String, login: String, name: String? = nil) {
        self.id = id
        self.login = login
        self.name = name
    }

    private enum CodingKeys: String, CodingKey { case id, login, name }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let value = try? container.decode(String.self, forKey: .id) { id = value }
        else { id = String(try container.decode(Int64.self, forKey: .id)) }
        login = try container.decode(String.self, forKey: .login)
        name = try container.decodeIfPresent(String.self, forKey: .name)
    }
}

public struct AuthSession: Codable, Equatable, Sendable {
    public let authenticated: Bool
    public let oauthConfigured: Bool?
    public let csrfToken: String?
    public let user: AccountUser?
}

public struct NativeSessionExchange: Codable, Equatable, Sendable {
    public let credential: String
    public let csrfToken: String
    public let user: AccountUser
    public let expiresAt: String
}

public struct AccountToken: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let prefix: String
    public let scopes: [String]
    public let createdAt: String
    public let expiresAt: String?
    public let lastUsedAt: String?
    public let revokedAt: String?
}

public struct CreatedAccountToken: Decodable, Equatable, Sendable {
    public let token: String
    public let metadata: AccountToken

    private enum CodingKeys: String, CodingKey { case token }

    public init(from decoder: Decoder) throws {
        token = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .token)
        metadata = try AccountToken(from: decoder)
    }
}
