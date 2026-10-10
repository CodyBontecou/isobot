import Foundation
import Observation
import AuthenticationServices

struct ChatJob: Identifiable {
    let id: String
    let prompt: String
    let baseline: Set<String>
    var pending = true
    var terminal = false
    var error: String?
    var reply: String?
}

@MainActor @Observable
final class AppModel {
    private(set) var api: IsobotAPIClient?
    private(set) var connectionID = UUID()
    private(set) var user: AccountUser?
    private(set) var isSession = false
    private(set) var conversation: String
    private(set) var conversations: [String]
    private(set) var snapshot = ConversationSnapshot()
    private(set) var jobs: [ChatJob] = []
    var originText: String
    var draft = ""
    var error: String?
    var connecting = false
    var loading = false
    var loadingOlder = false
    var stopping = false
    var oauthConfigured = true
    private var drafts: [String: String] = [:]
    private var initializedHistory = false
    private var refreshSequence = 0
    private let signIn = GitHubSignIn()
    private let defaults: UserDefaults
    private let previewMode: Bool

    init(client: IsobotAPIClient? = nil, user: AccountUser? = nil, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        #if DEBUG
        previewMode = ProcessInfo.processInfo.arguments.contains("--preview") || client?.origin == PreviewServer.origin
        #else
        previewMode = false
        #endif
        originText = defaults.string(forKey: "serverOrigin") ?? "https://isobot-pi.costream.workers.dev"
        let storedConversation = defaults.string(forKey: "conversation") ?? "vox"
        conversation = APIValidation.isIdentifier(storedConversation) ? storedConversation : "vox"
        conversations = (defaults.stringArray(forKey: "conversations") ?? ["vox", "default"]).filter(APIValidation.isIdentifier)
        if !conversations.contains(conversation) { conversations.append(conversation) }
        if let client { connect(client, user: user) }
    }

    var busy: Bool { snapshot.busy || !snapshot.pending.isEmpty || jobs.contains(where: \.pending) }
    var usesPreviewData: Bool { previewMode }
    var optimisticJobs: [ChatJob] {
        jobs.filter { job in !snapshot.entries.contains { $0.role == .user && $0.text == job.prompt && !job.baseline.contains($0.id) } }
    }
    var unrecordedReplies: [ChatJob] {
        jobs.filter { job in job.reply != nil && !snapshot.entries.contains { $0.role == .assistant && $0.text == job.reply && !job.baseline.contains($0.id) } }
    }

    func restore() async {
        guard api == nil, !connecting else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview") {
            do { connect(try PreviewServer.makeClient(), user: PreviewServer.user) }
            catch { self.error = error.localizedDescription }
            return
        }
        #endif
        let epoch = connectionID
        let expectedOrigin = originText
        connecting = true
        defer { connecting = false }
        do {
            if let saved = try CredentialStore.read(), saved.origin == originText,
               let origin = URL(string: saved.origin) {
                let client = try IsobotAPIClient(origin: origin, sessionCookie: saved.credential)
                let session = try await client.session()
                guard epoch == connectionID, expectedOrigin == originText, !Task.isCancelled else { return }
                if session.authenticated, let csrf = session.csrfToken, let user = session.user {
                    connect(try IsobotAPIClient(origin: origin, sessionCookie: saved.credential, csrfToken: csrf), user: user)
                    return
                }
                CredentialStore.clear()
            }
            if let origin = URL(string: originText) {
                let session = try await IsobotAPIClient(origin: origin).session()
                guard epoch == connectionID, expectedOrigin == originText, !Task.isCancelled else { return }
                oauthConfigured = session.oauthConfigured ?? false
            }
        } catch { if epoch == connectionID && expectedOrigin == originText { self.error = error.localizedDescription } }
    }

    func loginWithGitHub() async {
        guard !previewMode else { error = "This preview uses sample data. Relaunch without preview mode to connect to your real workspace."; return }
        guard !connecting else { return }
        connecting = true; error = nil
        let expectedOrigin = originText
        let epoch = connectionID
        defer { connecting = false }
        do {
            guard let origin = URL(string: originText) else { throw ConnectionError.invalidOrigin }
            _ = try IsobotAPIClient(origin: origin)
            let result = try await signIn.signIn(origin: origin, conversation: conversation)
            guard expectedOrigin == originText, epoch == connectionID else { return }
            let client = try IsobotAPIClient(origin: origin, sessionCookie: result.credential, csrfToken: result.csrfToken)
            try CredentialStore.save(SavedConnection(origin: client.origin.absoluteString, credential: result.credential))
            connect(client, user: result.user)
        } catch {
            if epoch == connectionID && expectedOrigin == originText && (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { self.error = error.localizedDescription }
        }
    }

    func loginWithToken(_ token: String) async {
        guard !previewMode else { error = "This preview uses sample data. Relaunch without preview mode to connect to your real workspace."; return }
        guard !connecting else { return }
        connecting = true; error = nil
        let epoch = connectionID
        let expectedOrigin = originText
        defer { connecting = false }
        do {
            guard let origin = URL(string: originText) else { throw ConnectionError.invalidOrigin }
            let clean = token.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "^Bearer\\s+", with: "", options: .regularExpression)
            let client = try IsobotAPIClient(origin: origin, bearerToken: clean)
            _ = try await client.conversation(conversation: conversation)
            guard epoch == connectionID, expectedOrigin == originText, !Task.isCancelled else { return }
            if !previewMode { CredentialStore.clear() }
            connect(client, user: nil)
        } catch { if epoch == connectionID && expectedOrigin == originText { self.error = error.localizedDescription } }
    }

    private func connect(_ client: IsobotAPIClient, user: AccountUser?) {
        clearConversation()
        api = client; self.user = user; isSession = user != nil
        originText = client.origin.absoluteString
        connectionID = UUID(); error = nil
        if !previewMode { defaults.set(originText, forKey: "serverOrigin") }
    }

    func disconnect() async {
        let client = api
        let session = isSession
        clearConnection()
        if session { try? await client?.logout() }
    }

    private func clearConnection() {
        connectionID = UUID(); api = nil; user = nil; isSession = false
        if !previewMode { CredentialStore.clear() }
        drafts = [:]; draft = ""
        clearConversation()
    }

    private func clearConversation() {
        snapshot = ConversationSnapshot(); jobs = []; initializedHistory = false
        refreshSequence += 1; loading = false; loadingOlder = false; stopping = false
    }

    func selectConversation(_ value: String) throws {
        guard APIValidation.isIdentifier(value) else { throw ConnectionError.invalidConversation }
        guard value != conversation else { return }
        drafts[conversation] = draft
        conversation = value; connectionID = UUID(); clearConversation()
        draft = drafts[value] ?? ""; error = nil
        if !conversations.contains(value) { conversations.append(value) }
        if !previewMode {
            defaults.set(value, forKey: "conversation")
            defaults.set(conversations, forKey: "conversations")
        }
    }

    func watchConversation() async {
        let epoch = connectionID
        let selectedConversation = conversation
        await refresh(initial: true)
        while !Task.isCancelled, epoch == connectionID, api != nil {
            do { try await Task.sleep(for: .seconds(busy ? 2.5 : 12)) } catch { return }
            guard epoch == connectionID else { return }
            for job in jobs where job.pending {
                guard epoch == connectionID, !Task.isCancelled, let api else { return }
                do {
                    let result = try await api.chatStatus(requestID: job.id, conversation: selectedConversation)
                    if epoch == connectionID { settle(result) }
                } catch { handle(error, connectionID: epoch) }
            }
            guard epoch == connectionID else { return }
            await refresh()
        }
    }

    func refresh(initial: Bool = false) async {
        guard let api else { return }
        let epoch = connectionID
        refreshSequence += 1; let sequence = refreshSequence
        if initial { loading = true }
        defer { if epoch == connectionID && sequence == refreshSequence { loading = false } }
        do {
            let latest = try await api.conversation(conversation: conversation, limit: 100)
            guard epoch == connectionID, sequence == refreshSequence, !Task.isCancelled else { return }
            if !initializedHistory {
                snapshot = latest; initializedHistory = true
            } else {
                var entries = Dictionary(uniqueKeysWithValues: snapshot.entries.map { ($0.id, $0) })
                for entry in latest.entries { entries[entry.id] = entry }
                snapshot = ConversationSnapshot(model: latest.model, busy: latest.busy, pending: latest.pending,
                    entries: entries.values.sorted { (Int($0.id) ?? 0) < (Int($1.id) ?? 0) }, nextCursor: snapshot.nextCursor)
            }
        } catch { handle(error, connectionID: epoch) }
    }

    func loadOlder() async {
        guard let api, let cursor = snapshot.nextCursor, !loadingOlder else { return }
        let epoch = connectionID; loadingOlder = true
        defer { if epoch == connectionID { loadingOlder = false } }
        do {
            let older = try await api.conversation(conversation: conversation, limit: 100, before: cursor)
            guard epoch == connectionID, !Task.isCancelled else { return }
            let ids = Set(snapshot.entries.map(\.id))
            snapshot = ConversationSnapshot(model: snapshot.model, busy: snapshot.busy, pending: snapshot.pending,
                entries: older.entries.filter { !ids.contains($0.id) } + snapshot.entries, nextCursor: older.nextCursor)
        } catch { handle(error, connectionID: epoch) }
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 16000, !busy else { return }
        draft = ""
        await submit(ChatJob(id: UUID().uuidString.lowercased(), prompt: text, baseline: Set(snapshot.entries.map(\.id))))
    }

    func retry(_ job: ChatJob) async {
        guard !busy else { return }
        if job.terminal {
            jobs.removeAll { $0.id == job.id }
            await submit(ChatJob(id: UUID().uuidString.lowercased(), prompt: job.prompt, baseline: Set(snapshot.entries.map(\.id))))
        } else { await submit(job) }
    }

    private func submit(_ input: ChatJob) async {
        guard let api else { return }
        let epoch = connectionID; error = nil
        var job = input; job.pending = true; job.error = nil
        if let index = jobs.firstIndex(where: { $0.id == job.id }) { jobs[index] = job } else { jobs.append(job) }
        do {
            let result = try await api.sendChat(prompt: job.prompt, conversation: conversation, requestID: job.id)
            guard epoch == connectionID else { return }
            settle(result); await refresh()
        } catch {
            guard epoch == connectionID else { return }
            if let index = jobs.firstIndex(where: { $0.id == job.id }) { jobs[index].pending = false; jobs[index].error = error.localizedDescription }
            handle(error, connectionID: epoch)
        }
    }

    private func settle(_ result: ChatOperation) {
        guard result.isTerminal, let index = jobs.firstIndex(where: { $0.id == result.requestId || $0.id == result.operationId }) else { return }
        jobs[index].pending = false; jobs[index].terminal = true
        jobs[index].reply = result.text
        if result.status == .unanswered { jobs[index].error = result.reason ?? "Pi did not complete this request." }
    }

    func stop() async {
        guard let api, !stopping else { return }
        let epoch = connectionID
        let selectedConversation = conversation
        let ids = Set(jobs.filter(\.pending).map(\.id) + snapshot.pending.map(\.operationId))
        stopping = true
        defer { if epoch == connectionID { stopping = false } }
        for id in ids {
            guard epoch == connectionID, !Task.isCancelled else { return }
            do {
                let result = try await api.stopChat(requestID: id, conversation: selectedConversation)
                guard epoch == connectionID else { return }; settle(result)
            } catch { handle(error, connectionID: epoch) }
        }
        if epoch == connectionID { await refresh() }
    }

    func handle(_ error: Error, connectionID epoch: UUID) {
        guard epoch == connectionID, !(error is CancellationError), (error as NSError).code != NSURLErrorCancelled else { return }
        if let apiError = error as? APIError, apiError.isUnauthorized {
            clearConnection()
            self.error = "Your connection expired. Sign in again to continue."
        } else { self.error = error.localizedDescription }
    }

    private enum ConnectionError: LocalizedError {
        case invalidOrigin, invalidConversation
        var errorDescription: String? {
            switch self {
            case .invalidOrigin: return "Enter a valid HTTPS server origin."
            case .invalidConversation: return "Use 1–100 letters, digits, underscores, or hyphens."
            }
        }
    }
}
