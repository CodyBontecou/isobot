import Foundation

public enum APIValidation {
    public static let maxPromptLength = 16_000
    public static let maxFileBytes = 131_072
    public static let maxJavaScriptInteger = 9_007_199_254_740_991

    public static func isIdentifier(_ value: String) -> Bool {
        matchesEntireString(value, pattern: "[A-Za-z0-9_-]{1,100}")
    }

    public static func isPrompt(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf16.count <= maxPromptLength
    }

    public static func isWorkspacePath(_ path: String) -> Bool {
        guard !path.isEmpty, path.utf8.count <= 256,
              !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0 == "\\" || $0 == ":" }) else {
            return false
        }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return parts.count <= 16 && parts.allSatisfy {
            !$0.isEmpty && $0 != "." && $0 != ".." && $0.trimmingCharacters(in: .whitespacesAndNewlines) == $0
        }
    }

    public static func isWorkspaceContent(_ value: String, maxBytes: Int = maxFileBytes) -> Bool {
        !value.contains("\0") && value.utf8.count <= maxBytes
    }

    public static func isRevision(_ value: Int) -> Bool { value > 0 && value <= maxJavaScriptInteger }

    public static func isCursor(_ value: String) -> Bool {
        matchesEntireString(value, pattern: "[1-9][0-9]*")
            && Int(value).map(isRevision) == true
    }

    public static func isCaptureID(_ value: String) -> Bool {
        matchesEntireString(value, pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    }

    public static func isSessionSecret(_ value: String) -> Bool {
        matchesEntireString(value, pattern: "[A-Za-z0-9_-]{43}")
    }

    public static func isCodeVerifier(_ value: String) -> Bool {
        matchesEntireString(value, pattern: "[A-Za-z0-9._~-]{43,128}")
    }

    private static func matchesEntireString(_ value: String, pattern: String) -> Bool {
        value.range(of: "\\A(?:\(pattern))\\z", options: .regularExpression) != nil
    }
}
