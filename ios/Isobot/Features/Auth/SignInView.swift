import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var token = ""
    @State private var showToken = false
    @State private var showServer = false
    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    HStack(spacing: 10) {
                        PiMark(size: 36)
                        Text("Pi").font(.title2.weight(.semibold))
                        Spacer()
                        Label("Private workspace", systemImage: "lock").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.top, 16)
                    VStack(alignment: .leading, spacing: 14) {
                        Text("YOUR DURABLE AGENT").font(.caption.weight(.semibold)).tracking(2).foregroundStyle(PiTheme.accent)
                        Text("Your workspace,\nready when you are.")
                            .font(.system(.largeTitle, design: .serif).weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Your conversations, Vox captures, and files live here. Sign in to continue with Pi.")
                            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(alignment: .leading, spacing: 20) {
                        feature("Conversations", detail: "Pick up with your context intact.", icon: "bubble.left.and.bubble.right")
                        feature("Vox captures", detail: "Your original Markdown, saved for later.", icon: "book")
                        feature("Workspace", detail: "Keep the files Pi works with close at hand.", icon: "folder")
                    }
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Sign in to Pi").font(.title2.weight(.semibold))
                        Text("Continue with your authorized GitHub account.").font(.callout).foregroundStyle(.secondary)
                        if let error = model.error { InlineError(text: error) }
                        if model.usesPreviewData {
                            Button("Open preview", systemImage: "eye") { Task { await model.restore() } }
                                .buttonStyle(.borderedProminent)
                            Text("Sample data. Relaunch without preview mode to sign in to your real workspace.").font(.caption).foregroundStyle(.secondary)
                        }
                        Button { Task { await model.loginWithGitHub() } } label: {
                            HStack {
                                if model.connecting { ProgressView().tint(.white) } else { Image(systemName: "person.badge.key") }
                                Text("Continue with GitHub").fontWeight(.semibold)
                                Spacer()
                                Image(systemName: "arrow.up.right")
                            }
                            .padding(16).foregroundStyle(.white)
                            .background(PiTheme.accent, in: RoundedRectangle(cornerRadius: 14))
                        }
                        .disabled(model.connecting || !model.oauthConfigured || model.usesPreviewData)
                        .opacity(!model.oauthConfigured || model.usesPreviewData ? 0.5 : 1)
                        .accessibilityIdentifier("githubSignIn")
                        if !model.oauthConfigured {
                            Text("GitHub sign-in is unavailable on this server. You can connect with an existing token.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        DisclosureGroup("Use a bearer token", isExpanded: $showToken) {
                            VStack(spacing: 12) {
                                SecureField("Paste your Vox or API token", text: $token)
                                    .textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .padding(12).background(PiTheme.background, in: RoundedRectangle(cornerRadius: 10))
                                    .accessibilityIdentifier("bearerToken")
                                Button("Connect") {
                                    let value = token
                                    Task { await model.loginWithToken(value); if model.api != nil { token = "" } }
                                }
                                .buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
                                .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.connecting)
                                Text("Bearer tokens stay in memory until you disconnect. GitHub sessions are stored securely in Keychain.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.padding(.top, 12)
                        }
                        .font(.callout).disabled(model.usesPreviewData)
                    }
                    .padding(22).background(PiTheme.paper, in: RoundedRectangle(cornerRadius: 24))
                    Button("Server settings", systemImage: "gearshape") { showServer = true }
                        .font(.callout).frame(maxWidth: .infinity).disabled(model.connecting || model.usesPreviewData)
                    Text("A conversation you can come back to.")
                        .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
                .padding(24).frame(maxWidth: 600).frame(maxWidth: .infinity)
            }
            .background(PiTheme.background)
            .sheet(isPresented: $showServer) {
                ServerSettingsView(origin: model.originText) { value in
                    model.originText = value; model.error = nil
                    UserDefaults.standard.set(value, forKey: "serverOrigin")
                    Task { await model.restore() }
                }
            }
        }
    }

    private func feature(_ title: String, detail: String, icon: String) -> some View {
        HStack(spacing: 16) {
            Image(systemName: icon).font(.title3).foregroundStyle(PiTheme.accent)
                .frame(width: 44, height: 44).background(PiTheme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.callout.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct ServerSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State var origin: String
    let onSave: (String) -> Void
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Server origin") {
                    TextField("https://your-worker.workers.dev", text: $origin)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("Use your Isobot Worker’s HTTPS origin. localhost HTTP is available for development.").font(.caption).foregroundStyle(.secondary)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Server")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        do {
                            guard let url = URL(string: origin.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
                            let client = try IsobotAPIClient(origin: url)
                            onSave(client.origin.absoluteString); dismiss()
                        } catch { self.error = error.localizedDescription }
                    }
                }
            }
        }
    }
}
