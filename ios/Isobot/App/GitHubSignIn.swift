import AuthenticationServices
import CryptoKit
import UIKit

@MainActor
final class GitHubSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func signIn(origin: URL, conversation: String) async throws -> NativeSessionExchange {
        let verifier = try randomVerifier()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        var components = URLComponents(url: origin.appendingPathComponent("auth/github/login"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "client", value: "ios"), URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "conversation", value: conversation)]
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: components.url!, callbackURLScheme: "isobot") { url, error in
                if let url { continuation.resume(returning: url) }
                else { continuation.resume(throwing: error ?? SignInError.failed) }
            }
            session.presentationContextProvider = self
            self.session = session
            if !session.start() { self.session = nil; continuation.resume(throwing: SignInError.failed) }
        }
        session = nil
        guard callback.scheme == "isobot", callback.host == "auth", callback.path.isEmpty || callback.path == "/",
              let result = URLComponents(url: callback, resolvingAgainstBaseURL: false) else { throw SignInError.failed }
        if let error = result.queryItems?.first(where: { $0.name == "authError" || $0.name == "error" })?.value {
            throw SignInError.server(error)
        }
        let codes = result.queryItems?.filter { $0.name == "code" } ?? []
        guard codes.count == 1, let code = codes.first?.value, !code.isEmpty else { throw SignInError.failed }
        return try await IsobotAPIClient(origin: origin).exchange(code: code, codeVerifier: verifier)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }

    private func randomVerifier() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw SignInError.failed }
        return Data(bytes).base64URL
    }

    private enum SignInError: LocalizedError {
        case failed, server(String)
        var errorDescription: String? {
            switch self {
            case .failed: return "GitHub sign-in could not finish. Please try again."
            case .server("not_allowed"): return "This GitHub account cannot access this workspace."
            case .server("not_configured"): return "GitHub sign-in is not configured on this server."
            case .server("invalid_state"): return "That sign-in expired. Please start again."
            case .server: return "GitHub sign-in could not finish. Please try again."
            }
        }
    }
}

private extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
