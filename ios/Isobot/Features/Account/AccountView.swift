import SwiftUI
import UIKit

private struct AccountTokenCreation: Identifiable {
    let id = UUID()
}

struct AccountView: View {
    @Environment(AppModel.self) private var model
    @State private var tokens: [AccountToken]?
    @State private var error: String?
    @State private var loading = false
    @State private var busy = false
    @State private var loadID = UUID()
    @State private var creation: AccountTokenCreation?
    @State private var revoking: AccountToken?
    @State private var showRevoke = false

    private var activeCount: Int {
        tokens?.filter { $0.revokedAt == nil && !AccountTokenStatus.expired($0) }.count ?? 0
    }

    var body: some View {
        Form {
            Section("Connection") {
                if model.usesPreviewData { Label("Preview data", systemImage: "eye") }
                if let user = model.user {
                    Label {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(user.name ?? user.login).font(.headline)
                            Text("@\(user.login)").font(.callout).foregroundStyle(.secondary)
                        }
                    } icon: { Image(systemName: "person.crop.circle") }
                } else {
                    Label("Connected with an API token", systemImage: "key")
                }
                LabeledContent("Authentication", value: model.isSession ? "GitHub account" : "API token")
            }
            if let error { WorkspaceErrorView(message: error) { Task { await load() } } }
            if model.isSession {
                Section {
                    Button("Create API token", systemImage: "plus") { creation = AccountTokenCreation() }
                        .disabled(busy || loading)
                } footer: {
                    Text("Connect Vox or another client to your agent with an API token.")
                }
                Section {
                    if tokens == nil, loading {
                        ProgressView("Loading API tokens…")
                    } else if let tokens {
                        if tokens.isEmpty {
                            ContentUnavailableView("No API tokens", systemImage: "key",
                                description: Text("Create a token to connect another client."))
                        }
                        ForEach(tokens) { token in
                            DisclosureGroup {
                                LabeledContent("Prefix", value: token.prefix)
                                LabeledContent("Permissions", value: token.scopes.joined(separator: " + "))
                                LabeledContent("Created", value: WorkspaceFormat.date(token.createdAt))
                                LabeledContent("Expires", value: token.expiresAt.map(WorkspaceFormat.date) ?? "Never")
                                LabeledContent("Last used", value: token.lastUsedAt.map(WorkspaceFormat.date) ?? "Never")
                                if let revokedAt = token.revokedAt {
                                    LabeledContent("Revoked", value: WorkspaceFormat.date(revokedAt))
                                } else {
                                    Button("Revoke token", systemImage: "trash", role: .destructive) {
                                        revoking = token
                                        showRevoke = true
                                    }
                                    .disabled(busy)
                                }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(token.name).foregroundStyle(.primary)
                                    Text(AccountTokenStatus.description(token))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } header: { Text("API tokens · \(activeCount) active") }
            } else {
                Section("API tokens") {
                    Text("Sign in with GitHub to create and revoke account tokens.")
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                Button(model.isSession ? "Sign out" : "Disconnect", role: .destructive) {
                    guard !busy else { return }
                    busy = true
                    Task {
                        await model.disconnect()
                        busy = false
                    }
                }
                .disabled(busy)
            }
        }
        .navigationTitle("Account")
        .refreshable { await load() }
        .task(id: model.connectionID) {
            tokens = nil
            error = nil
            revoking = nil
            showRevoke = false
            creation = nil
            await load()
        }
        .sheet(item: $creation) { _ in
            NavigationStack {
                AccountCreateTokenView { Task { await load() } }
            }
        }
        .confirmationDialog("Revoke \(revoking?.name ?? "this token")?", isPresented: $showRevoke,
            titleVisibility: .visible) {
                Button("Revoke token", role: .destructive) {
                    if let revoking { Task { await revoke(revoking) } }
                }
                Button("Keep token", role: .cancel) { revoking = nil }
            } message: {
                Text("Clients using this token will lose access immediately. This cannot be undone.")
            }
    }

    @MainActor private func load() async {
        guard model.isSession, let api = model.api else { return }
        let connection = model.connectionID
        let request = UUID()
        loadID = request
        loading = true
        defer { if model.connectionID == connection, loadID == request { loading = false } }
        do {
            let result = try await api.listTokens()
            guard !Task.isCancelled, model.connectionID == connection, loadID == request, model.isSession else { return }
            tokens = result
            error = nil
        } catch {
            guard !Task.isCancelled, model.connectionID == connection, loadID == request else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else { self.error = WorkspaceFormat.error(error) }
        }
    }

    @MainActor private func revoke(_ token: AccountToken) async {
        guard model.isSession, !busy, let api = model.api else { return }
        let connection = model.connectionID
        busy = true
        defer { if model.connectionID == connection { busy = false; revoking = nil } }
        do {
            try await api.revokeToken(id: token.id)
            guard !Task.isCancelled, model.connectionID == connection, model.isSession else { return }
            await load()
        } catch {
            guard !Task.isCancelled, model.connectionID == connection else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else { self.error = WorkspaceFormat.error(error) }
        }
    }
}

private enum AccountTokenStatus {
    static func expired(_ token: AccountToken) -> Bool {
        guard let value = token.expiresAt else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return false }
        return date <= Date()
    }

    static func description(_ token: AccountToken) -> String {
        if token.revokedAt != nil { return "Revoked" }
        if expired(token) { return "Expired" }
        if let expires = token.expiresAt { return "Expires \(WorkspaceFormat.date(expires))" }
        return "Active · No expiry"
    }
}

private struct AccountCreateTokenView: View {
    private enum Expiry: Int, CaseIterable, Identifiable {
        case month = 30, quarter = 90, year = 365, never = -1
        var id: Self { self }
        var title: String {
            switch self {
            case .month: "After 30 days"
            case .quarter: "After 90 days"
            case .year: "After one year"
            case .never: "Never"
            }
        }
        var days: Int? { self == .never ? nil : rawValue }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onCreated: () -> Void
    @State private var name = "Vox"
    @State private var expiry: Expiry = .quarter
    @State private var write = true
    @State private var busy = false
    @State private var error: String?
    @State private var secret: String?
    @State private var copied = false

    var body: some View {
        Form {
            if let error { WorkspaceErrorView(message: error) }
            if let secret {
                Section {
                    Text(secret)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .privacySensitive()
                    Button {
                        UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: secret]],
                            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy token", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    Button("Done") { self.secret = nil; dismiss() }
                } header: { Text("Your new token") } footer: {
                    Text("Copy it now. This value can only be shown once. It is not saved on this device.")
                }
            } else {
                Section {
                    TextField("e.g. Vox on my phone", text: $name)
                        .accessibilityLabel("Token name")
                    Picker("Expires", selection: $expiry) {
                        ForEach(Expiry.allCases) { Text($0.title).tag($0) }
                    }
                    Toggle("Allow prompts and workspace changes", isOn: $write)
                } header: { Text("Token access") } footer: {
                    Text(write ? "This token can read your agent, send prompts, and change workspace files."
                        : "This token can read your agent and workspace. It cannot send prompts or change files.")
                }
                Section {
                    Button {
                        Task { await create() }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text("Create token") }
                            Spacer()
                        }
                    }
                    .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 80)
                }
                if name.count > 80 {
                    Text("Use a name with 80 characters or fewer.").font(.caption).foregroundStyle(.red)
                }
            }
        }
        .disabled(busy)
        .navigationTitle(secret == nil ? "Create API token" : "Token created")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(secret == nil ? "Cancel" : "Close") { secret = nil; dismiss() }.disabled(busy)
            }
        }
        .interactiveDismissDisabled(busy)
        .onChange(of: model.connectionID) { _, _ in secret = nil; dismiss() }
        .onDisappear { secret = nil }
    }

    @MainActor private func create() async {
        guard model.isSession, !busy, let api = model.api else { return }
        let connection = model.connectionID
        busy = true
        error = nil
        defer { if model.connectionID == connection { busy = false } }
        do {
            let result = try await api.createToken(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                scopes: write ? ["read", "write"] : ["read"], expiresInDays: expiry.days)
            guard !Task.isCancelled, model.connectionID == connection, model.isSession else { return }
            secret = result.token
            copied = false
            onCreated()
        } catch {
            guard !Task.isCancelled, model.connectionID == connection else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else { self.error = WorkspaceFormat.error(error) }
        }
    }
}
