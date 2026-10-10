import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var conversationPicker = false
    @State private var followsLatest = true
    @State private var newConversation = false
    @State private var conversationName = ""
    @FocusState private var composing: Bool
    var body: some View {
        @Bindable var model = model
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if let error = model.error {
                        InlineError(text: error)
                            .onTapGesture { model.error = nil }
                    }
                    if model.loading && model.snapshot.entries.isEmpty {
                        ProgressView("Loading conversation…").frame(maxWidth: .infinity).padding(.top, 80)
                    } else if model.snapshot.entries.isEmpty && model.jobs.isEmpty {
                        ChatWelcomeView { model.draft = $0; composing = true }
                    }
                    if model.snapshot.nextCursor != nil {
                        Button { Task { await model.loadOlder() } } label: {
                            HStack { if model.loadingOlder { ProgressView() }; Text("Load earlier messages") }
                                .frame(maxWidth: .infinity).padding(.vertical, 10)
                        }.disabled(model.loadingOlder)
                    }
                    ForEach(model.snapshot.entries) { entry in ChatEntryView(entry: entry) }
                    ForEach(model.optimisticJobs) { job in
                        ChatEntryView(entry: ConversationEntry(id: job.id, role: .user, text: job.prompt))
                    }
                    ForEach(model.unrecordedReplies) { job in
                        ChatEntryView(entry: ConversationEntry(id: "reply-\(job.id)", role: .assistant, text: job.reply ?? ""))
                    }
                    ForEach(model.jobs.filter { $0.error != nil }) { job in
                        VStack(alignment: .leading, spacing: 8) {
                            InlineError(text: job.error ?? "Request failed.")
                            Button("Retry", systemImage: "arrow.clockwise") { Task { await model.retry(job) } }
                                .disabled(model.busy)
                        }
                    }
                    if model.busy {
                        HStack(spacing: 10) { PiMark(size: 24); ProgressView(); Text("Pi is working…").font(.callout).foregroundStyle(.secondary) }
                    }
                    Color.clear.frame(height: 1).id("latest")
                        .onAppear { followsLatest = true }.onDisappear { followsLatest = false }
                }
                .padding(20).frame(maxWidth: 760).frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.refresh() }
            .overlay(alignment: .bottomTrailing) {
                if !followsLatest && !model.snapshot.entries.isEmpty {
                    Button { proxy.scrollTo("latest", anchor: .bottom) } label: {
                        Image(systemName: "arrow.down").padding(14).background(.regularMaterial, in: Circle())
                    }
                    .accessibilityLabel("Jump to latest message").padding(16)
                }
            }
            .onChange(of: model.snapshot.entries.last?.id) { _, _ in
                if followsLatest { proxy.scrollTo("latest", anchor: .bottom) }
            }
            .onChange(of: model.jobs.count) { _, _ in proxy.scrollTo("latest", anchor: .bottom) }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        }
        .background(PiTheme.paper)
        .navigationTitle(model.usesPreviewData ? "\(model.conversation) · Preview" : model.conversation)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { conversationPicker = true } label: { Image(systemName: "text.bubble") }
                    .accessibilityLabel("Choose conversation")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Text(model.snapshot.model.isEmpty ? "Pi agent" : model.snapshot.model)
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                    Button("New conversation", systemImage: "plus") { newConversation = true }
                } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("Conversation options")
            }
        }
        .sheet(isPresented: $conversationPicker) { ConversationPicker() }
        .alert("New conversation", isPresented: $newConversation) {
            TextField("Conversation name", text: $conversationName).textInputAutocapitalization(.never)
            Button("Create") {
                do { try model.selectConversation(conversationName.trimmingCharacters(in: .whitespacesAndNewlines)); conversationName = "" }
                catch { model.error = error.localizedDescription }
            }
            Button("Cancel", role: .cancel) { conversationName = "" }
        } message: { Text("Use letters, digits, underscores, or hyphens. Each conversation has its own history and workspace.") }
    }

    private var composer: some View {
        @Bindable var model = model
        return VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Message Pi…", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6).focused($composing)
                    .padding(.vertical, 12).padding(.leading, 14)
                    .accessibilityIdentifier("messageComposer")
                if model.busy {
                    Button { Task { await model.stop() } } label: {
                        if model.stopping { ProgressView() } else { Image(systemName: "stop.fill") }
                    }
                    .disabled(model.stopping).accessibilityLabel("Stop request").frame(width: 44, height: 44)
                } else {
                    Button { Task { await model.send() } } label: {
                        Image(systemName: "arrow.up").font(.body.weight(.semibold))
                            .foregroundStyle(.white).frame(width: 40, height: 40)
                            .background(PiTheme.accent, in: Circle())
                    }
                    .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.draft.utf16.count > 16000)
                    .opacity(model.draft.isEmpty ? 0.45 : 1).padding(4).accessibilityLabel("Send message")
                }
            }
            .background(PiTheme.background, in: RoundedRectangle(cornerRadius: 24))
            if model.draft.utf16.count > 16000 {
                Text("Messages can contain up to 16,000 characters.").font(.caption).foregroundStyle(.red)
            } else {
                Text(model.snapshot.model.isEmpty ? "Your durable agent · \(model.conversation)" : model.snapshot.model)
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10).background(.regularMaterial)
    }
}

private struct ChatWelcomeView: View {
    var choose: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            PiMark(size: 56)
            Text("A little context.\nA lot of possibility.")
                .font(.system(.largeTitle, design: .serif).weight(.medium))
            Text("Ask Pi a question, work with your files, or pick up an idea from a saved Vox capture.")
                .foregroundStyle(.secondary)
            VStack(spacing: 10) {
                starter("Explore my captures", icon: "book", prompt: "Summarize my recent Vox captures and suggest useful next steps.")
                starter("Work with my files", icon: "folder", prompt: "Browse my workspace files and tell me what is available.")
                starter("Make a plan", icon: "sparkles", prompt: "Help me turn an idea into a practical plan.")
            }
        }.padding(.vertical, 32)
    }
    private func starter(_ title: String, icon: String, prompt: String) -> some View {
        Button { choose(prompt) } label: {
            HStack { Label(title, systemImage: icon); Spacer(); Image(systemName: "arrow.up.left") }
                .font(.callout).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .background(PiTheme.background, in: RoundedRectangle(cornerRadius: 14))
        }.buttonStyle(.plain)
    }
}

struct ChatEntryView: View {
    let entry: ConversationEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if entry.role == .tool {
                DisclosureGroup {
                    Text(entry.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                } label: {
                    Label(entry.toolResult?.name ?? "Tool result", systemImage: entry.toolResult?.error == true ? "exclamationmark.triangle" : "checkmark.circle")
                        .font(.callout).foregroundStyle(entry.toolResult?.error == true ? .red : .secondary)
                }
            } else {
                HStack(spacing: 8) {
                    if entry.role == .assistant { PiMark(size: 24) }
                    Text(entry.role == .user ? "You" : entry.role == .system ? "System" : "Pi").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Button { UIPasteboard.general.string = entry.text } label: { Image(systemName: "doc.on.doc").font(.caption) }
                        .frame(width: 44, height: 44).accessibilityLabel("Copy message")
                }
                if !entry.text.isEmpty {
                    if entry.role == .user { Text(entry.text).textSelection(.enabled) }
                    else { MarkdownView(text: entry.text) }
                }
                ForEach(entry.toolCalls ?? []) { call in
                    DisclosureGroup {
                        Text(call.arguments).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    } label: { Label(call.name, systemImage: "terminal").font(.callout).foregroundStyle(.secondary) }
                }
            }
        }
        .padding(entry.role == .user ? 16 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(entry.role == .user ? PiTheme.background : .clear, in: RoundedRectangle(cornerRadius: 18))
    }
}

private struct ConversationPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                Section("Conversations") {
                    ForEach(model.conversations, id: \.self) { name in
                        Button {
                            do { try model.selectConversation(name); dismiss() } catch { self.error = error.localizedDescription }
                        } label: {
                            HStack { Label(name, systemImage: "bubble.left"); Spacer(); if name == model.conversation { Image(systemName: "checkmark") } }
                        }
                    }
                }
                Section("New conversation") {
                    TextField("Conversation name", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Create", systemImage: "plus") {
                        do { try model.selectConversation(name.trimmingCharacters(in: .whitespacesAndNewlines)); dismiss() }
                        catch { self.error = error.localizedDescription }
                    }.disabled(name.isEmpty)
                    if let error { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Conversations")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
