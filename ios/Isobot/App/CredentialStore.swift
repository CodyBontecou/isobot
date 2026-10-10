import Foundation
import Security

struct SavedConnection: Codable {
    var origin: String
    var credential: String
}

enum CredentialStore {
    private static let service = "tech.isolated.isobot.session"
    static func read() throws -> SavedConnection? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: "current",
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ] as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return try JSONDecoder().decode(SavedConnection.self, from: data)
    }

    static func save(_ connection: SavedConnection) throws {
        let data = try JSONEncoder().encode(connection)
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "current"]
        let attributes: [CFString: Any] = [kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let inserted = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard inserted == errSecSuccess else { throw KeychainError(status: inserted) }
        } else if status != errSecSuccess { throw KeychainError(status: status) }
    }

    static func clear() {
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "current"] as CFDictionary)
    }

    private struct KeychainError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "The secure session could not be saved (\(status))." }
    }
}
