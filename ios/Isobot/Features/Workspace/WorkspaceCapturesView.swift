import SwiftUI
import UniformTypeIdentifiers

struct WorkspaceCapturesView: View {
    @Environment(AppModel.self) private var model
    @State private var captures: [Capture]?
    @State private var cursor: Int?
    @State private var error: String?
    @State private var loading = false
    @State private var loadID = UUID()

    var body: some View {
        List {
            if let error {
                WorkspaceErrorView(message: error) { Task { await load() } }
            }
            if captures == nil, loading {
                ProgressView("Loading captures…").frame(maxWidth: .infinity)
            } else if let captures {
                if captures.isEmpty {
                    ContentUnavailableView {
                        Label("Your thoughts, collected", systemImage: "tray")
                    } description: {
                        Text("Notes sent from Vox appear here. Memory captures are stored for Pi to use in this conversation.")
                    }
                } else {
                    Section {
                        ForEach(captures) { capture in
                            NavigationLink {
                                WorkspaceCaptureDetailView(id: capture.id)
                            } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack {
                                        Label(capture.mode == .memory ? "Memory" : "Prompt",
                                              systemImage: capture.mode == .memory ? "brain" : "text.bubble")
                                            .foregroundStyle(capture.mode == .memory ? .green : .orange)
                                        Spacer()
                                        Text(WorkspaceFormat.date(capture.receivedAt)).foregroundStyle(.secondary)
                                    }
                                    .font(.caption)
                                    Text(capture.preview.flatMap { $0.isEmpty ? nil : $0 } ?? "Empty capture")
                                        .lineLimit(3)
                                    Text(capture.status ?? "Stored")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    } header: { Text("Saved from Vox") }
                    if cursor != nil {
                        Button {
                            Task { await load(older: true) }
                        } label: {
                            HStack {
                                Spacer()
                                if loading { ProgressView() } else { Text("Load older captures") }
                                Spacer()
                            }
                        }
                        .disabled(loading)
                    }
                }
            }
        }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh captures", systemImage: "arrow.clockwise") { Task { await load() } }
                    .labelStyle(.iconOnly).disabled(loading)
            }
        }
        .task(id: model.connectionID) {
            captures = nil
            cursor = nil
            error = nil
            await load()
        }
    }

    @MainActor private func load(older: Bool = false) async {
        guard let api = model.api else { return }
        if older, (loading || cursor == nil) { return }
        let connection = model.connectionID
        let request = UUID()
        let before = older ? cursor : nil
        loadID = request
        loading = true
        defer { if model.connectionID == connection, loadID == request { loading = false } }
        do {
            let result = try await api.captures(conversation: model.conversation, limit: 25, before: before)
            guard !Task.isCancelled, model.connectionID == connection, loadID == request else { return }
            if older {
                let ids = Set((captures ?? []).map(\.id))
                captures = (captures ?? []) + result.items.filter { !ids.contains($0.id) }
            } else {
                captures = result.items
            }
            cursor = result.nextCursor
            error = nil
        } catch {
            guard !Task.isCancelled, model.connectionID == connection, loadID == request else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else { self.error = WorkspaceFormat.error(error) }
        }
    }
}

private struct WorkspaceCaptureDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var capture: Capture?
    @State private var loading = false
    @State private var error: String?
    @State private var loadID = UUID()
    @State private var exportText = ""
    @State private var exportName = ""
    @State private var exportType = UTType.plainText
    @State private var exporting = false

    var body: some View {
        List {
            if let error {
                WorkspaceErrorView(message: error) { Task { await load() } }
            }
            if let capture {
                Section {
                    LabeledContent("Mode", value: capture.mode == .memory ? "Memory" : "Prompt")
                    LabeledContent("Received", value: WorkspaceFormat.date(capture.receivedAt))
                    LabeledContent("Status", value: capture.result?.status ?? capture.status ?? "Stored")
                }
                Section("Original capture") {
                    if let markdown = capture.markdown, !markdown.isEmpty {
                        MarkdownView(text: markdown)
                    } else {
                        Text("This capture has no text.").foregroundStyle(.secondary)
                    }
                    exportActions(capture.markdown ?? "", name: "\(id).md", type: .plainText)
                }
                Section("Pi’s response") {
                    if let result = capture.result {
                        MarkdownView(text: result.text.flatMap { $0.isEmpty ? nil : $0 }
                            ?? result.reason ?? "No response text was recorded.")
                        if let text = result.text, !text.isEmpty {
                            exportActions(text, name: "\(id).response.md", type: .plainText)
                        }
                    } else {
                        Text(capture.mode == .memory
                            ? "Saved as memory. Ask Pi about this capture in the same conversation."
                            : "Pi’s response will appear here when processing finishes. Pull down to refresh.")
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Source JSON") {
                    let json = capture.payload?.prettyPrinted ?? "{}"
                    DisclosureGroup("Capture metadata") {
                        ScrollView(.horizontal) {
                            Text(json).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }
                    }
                    exportActions(json, name: "\(id).source.json", type: .json)
                }
            } else if loading {
                ProgressView("Opening capture…").frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Capture")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh capture", systemImage: "arrow.clockwise") { Task { await load() } }
                    .labelStyle(.iconOnly).disabled(loading)
            }
        }
        .task { await load() }
        .onChange(of: model.connectionID) { _, _ in dismiss() }
        .fileExporter(isPresented: $exporting, document: WorkspaceTextDocument(text: exportText), contentType: exportType,
            defaultFilename: exportName) { result in
                if case .failure(let failure) = result { error = WorkspaceFormat.error(failure) }
            }
    }

    private func exportActions(_ text: String, name: String, type: UTType) -> some View {
        HStack {
            ShareLink(item: text) { Label("Share", systemImage: "square.and.arrow.up") }
            Spacer()
            Button {
                exportText = text
                exportName = name
                exportType = type
                exporting = true
            } label: { Label("Save to Files", systemImage: "arrow.down.doc") }
        }
        .font(.callout)
        .buttonStyle(.borderless)
    }

    @MainActor private func load() async {
        guard let api = model.api else { return }
        let connection = model.connectionID
        let request = UUID()
        loadID = request
        loading = true
        defer { if model.connectionID == connection, loadID == request { loading = false } }
        do {
            let result = try await api.capture(id: id, conversation: model.conversation)
            guard !Task.isCancelled, model.connectionID == connection, loadID == request else { return }
            capture = result
            error = nil
        } catch {
            guard !Task.isCancelled, model.connectionID == connection, loadID == request else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else { self.error = WorkspaceFormat.error(error) }
        }
    }
}
