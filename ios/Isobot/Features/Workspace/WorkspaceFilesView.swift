import SwiftUI
import UniformTypeIdentifiers

private struct WorkspaceEditorRequest: Identifiable {
    let id = UUID()
    let file: WorkspaceFile?
    var initialPath = ""
    var initialContent = ""
}

private struct WorkspacePreviewRequest: Identifiable {
    let id = UUID()
    let path: String
    let text: String
}

struct WorkspaceFilesView: View {
    @Environment(AppModel.self) private var model
    @State private var listing: WorkspaceListing?
    @State private var search = ""
    @State private var error: String?
    @State private var loading = false
    @State private var editor: WorkspaceEditorRequest?
    @State private var importing = false
    @State private var importConnectionID: UUID?
    @State private var refreshID = UUID()
    @State private var loadID = UUID()

    private var files: [WorkspaceFile] {
        (listing?.files ?? []).filter { search.isEmpty || $0.path.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        List {
            if let error {
                WorkspaceErrorView(message: error) { Task { await load() } }
            }
            if listing == nil, loading {
                ProgressView("Loading workspace…")
                    .frame(maxWidth: .infinity)
            } else if let listing {
                if listing.files.isEmpty {
                    ContentUnavailableView {
                        Label("Room to think", systemImage: "folder")
                    } description: {
                        Text("Add notes, instructions, or working files. Pi can read and update this workspace.")
                    } actions: {
                        Button("Create a file") { editor = WorkspaceEditorRequest(file: nil) }
                            .buttonStyle(.borderedProminent)
                    }
                } else if files.isEmpty {
                    ContentUnavailableView.search(text: search)
                } else {
                    Section {
                        ForEach(files) { file in
                            Button {
                                editor = WorkspaceEditorRequest(file: file)
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "doc.text")
                                        .foregroundStyle(.tint)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(file.path).foregroundStyle(.primary)
                                        Text("Version \(file.revision) · \(WorkspaceFormat.bytes(file.bytes))")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.caption).foregroundStyle(.tertiary)
                                }
                            }
                            .accessibilityLabel("Open \(file.path), \(WorkspaceFormat.bytes(file.bytes))")
                        }
                    } footer: {
                        Text("\(listing.files.count) of \(listing.maxFiles) files · \(WorkspaceFormat.bytes(listing.totalBytes)) stored")
                    }
                }
            }
        }
        .searchable(text: $search, prompt: "Search files")
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("New file", systemImage: "doc.badge.plus") {
                        editor = WorkspaceEditorRequest(file: nil)
                    }
                    Button("Import text file", systemImage: "square.and.arrow.down") {
                        importConnectionID = model.connectionID
                        importing = true
                    }
                    Button("Refresh files", systemImage: "arrow.clockwise") { Task { await load() } }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("File actions")
                .disabled(model.api == nil || loading)
            }
        }
        .task(id: model.connectionID) {
            listing = nil
            editor = nil
            importing = false
            error = nil
            await load()
        }
        .onChange(of: refreshID) { _, _ in Task { await load() } }
        .sheet(item: $editor) { request in
            NavigationStack {
                WorkspaceFileEditor(request: request,
                    maxBytes: listing?.maxFileBytes ?? APIValidation.maxFileBytes,
                    existingPaths: Set(listing?.files.map(\.path) ?? [])) {
                        refreshID = UUID()
                    }
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.data]) { result in
            guard importConnectionID == model.connectionID else { return }
            switch result {
            case .success(let url): importFile(url)
            case .failure(let failure): error = WorkspaceFormat.error(failure)
            }
        }
    }

    @MainActor private func load() async {
        guard let api = model.api else { return }
        let connection = model.connectionID
        let request = UUID()
        loadID = request
        loading = true
        defer { if model.connectionID == connection, loadID == request { loading = false } }
        do {
            let result = try await api.workspace(conversation: model.conversation)
            guard !Task.isCancelled, model.connectionID == connection, loadID == request else { return }
            listing = result
            error = nil
        } catch {
            guard !Task.isCancelled, model.connectionID == connection, loadID == request else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else { self.error = WorkspaceFormat.error(error) }
        }
    }

    private func importFile(_ url: URL) {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let maxBytes = listing?.maxFileBytes ?? APIValidation.maxFileBytes
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= maxBytes else {
                error = "Choose a text file smaller than \(WorkspaceFormat.bytes(maxBytes))."
                return
            }
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            guard let text = String(data: data, encoding: .utf8),
                  APIValidation.isWorkspaceContent(text, maxBytes: maxBytes), !text.contains("\u{FFFD}") else {
                error = "Choose a UTF-8 text file. Binary files are not supported."
                return
            }
            guard APIValidation.isWorkspacePath(url.lastPathComponent) else {
                error = "This filename is not supported. Create a file with a relative path instead."
                return
            }
            guard !(listing?.files.contains(where: { $0.path == url.lastPathComponent }) ?? false) else {
                error = "A file with this name already exists. Rename the import, or open the saved file to edit it."
                return
            }
            editor = WorkspaceEditorRequest(file: nil, initialPath: url.lastPathComponent, initialContent: text)
        } catch {
            self.error = WorkspaceFormat.error(error)
        }
    }
}

private struct WorkspaceFileEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let request: WorkspaceEditorRequest
    let maxBytes: Int
    let existingPaths: Set<String>
    let onChanged: () -> Void
    @State private var file: WorkspaceFile?
    @State private var path: String
    @State private var draft: String
    @State private var savedContent = ""
    @State private var contentReady: Bool
    @State private var loading = false
    @State private var busy = false
    @State private var error: String?
    @State private var saved = false
    @State private var discard = false
    @State private var deleteConfirmation = false
    @State private var conflict = false
    @State private var exporting = false
    @State private var preview: WorkspacePreviewRequest?

    init(request: WorkspaceEditorRequest, maxBytes: Int, existingPaths: Set<String>, onChanged: @escaping () -> Void) {
        self.request = request
        self.maxBytes = maxBytes
        self.existingPaths = existingPaths
        self.onChanged = onChanged
        _file = State(initialValue: request.file)
        _path = State(initialValue: request.file?.path ?? request.initialPath)
        _draft = State(initialValue: request.initialContent)
        _contentReady = State(initialValue: request.file == nil)
    }

    private var dirty: Bool { contentReady && (draft != savedContent || (file == nil && !path.isEmpty)) }
    private var valid: Bool {
        contentReady && APIValidation.isWorkspacePath(path) && APIValidation.isWorkspaceContent(draft, maxBytes: maxBytes)
            && (file != nil || !existingPaths.contains(path))
    }

    var body: some View {
        VStack(spacing: 0) {
            if loading {
                ProgressView("Opening file…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !contentReady {
                VStack(spacing: 16) {
                    ContentUnavailableView("Couldn’t open this file", systemImage: "doc.questionmark",
                        description: Text(error ?? "Load the saved content before editing."))
                    Button("Try again") { Task { await open() } }.buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                if file == nil {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("notes/ideas.md", text: $path)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)
                            .disabled(busy)
                            .accessibilityLabel("File path")
                        Text("Use a relative path with folders to organize your notes.")
                            .font(.caption).foregroundStyle(.secondary)
                        if existingPaths.contains(path) {
                            Text("A file already exists at this path.").font(.caption).foregroundStyle(.red)
                        }
                    }
                    .padding()
                }
                if let error {
                    WorkspaceErrorView(message: error)
                        .padding(.horizontal).padding(.bottom, 8)
                }
                TextEditor(text: $draft)
                    .font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("File content")
                    .padding(.horizontal, 8)
                    .disabled(busy)
                HStack {
                    Text("\(WorkspaceFormat.bytes(draft.utf8.count)) / \(WorkspaceFormat.bytes(maxBytes))")
                        .foregroundStyle(draft.utf8.count > maxBytes ? .red : .secondary)
                    Spacer()
                    if saved { Label("Saved", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                    else { Text(dirty ? "Unsaved" : file.map { "Version \($0.revision)" } ?? "New file") }
                }
                .font(.caption).padding()
                Divider()
                HStack {
                    Button {
                        Task { await save() }
                    } label: {
                        if busy { ProgressView() } else { Label("Save file", systemImage: "square.and.arrow.up") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!valid || busy || (file != nil && !dirty))
                    Spacer()
                    Menu {
                        Button("Preview file", systemImage: "eye") {
                            preview = WorkspacePreviewRequest(path: path, text: draft)
                        }
                        ShareLink(item: draft) { Label("Share text", systemImage: "square.and.arrow.up") }
                        Button("Save to Files", systemImage: "arrow.down.doc") { exporting = true }
                        if file != nil {
                            Button("Delete file", systemImage: "trash", role: .destructive) { deleteConfirmation = true }
                        }
                    } label: { Image(systemName: "ellipsis.circle").font(.title2) }
                    .accessibilityLabel("More file actions")
                    .disabled(busy)
                }
                .padding()
            }
        }
        .navigationTitle(file?.path ?? "New file")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { if dirty { discard = true } else { dismiss() } }.disabled(busy)
            }
        }
        .interactiveDismissDisabled(dirty || busy)
        .task { if request.file != nil { await open() } }
        .onChange(of: draft) { _, _ in saved = false }
        .onChange(of: model.connectionID) { _, _ in dismiss() }
        .sheet(item: $preview) { document in
            NavigationStack {
                WorkspaceFilePreviewView(document: document)
            }
        }
        .confirmationDialog("Discard unsaved changes?", isPresented: $discard, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .confirmationDialog("Delete \(path)?", isPresented: $deleteConfirmation, titleVisibility: .visible) {
            Button("Delete file", role: .destructive) { Task { await remove() } }
        } message: { Text("The saved file and any unsaved edits will be removed. This cannot be undone.") }
        .alert("This file changed", isPresented: $conflict) {
            Button("Keep my draft", role: .cancel) {}
            Button("Reload saved version", role: .destructive) { Task { await open() } }
        } message: {
            Text("Your draft has been kept. Share or export it before reloading the latest saved version. Saving requires the latest revision.")
        }
        .fileExporter(isPresented: $exporting, document: WorkspaceTextDocument(text: draft), contentType: .plainText,
            defaultFilename: path.split(separator: "/").last.map(String.init) ?? "file.txt") { result in
                if case .failure(let failure) = result { error = WorkspaceFormat.error(failure) }
            }
    }

    @MainActor private func open() async {
        guard let api = model.api else { return }
        let connection = model.connectionID
        loading = true
        defer { if connection == model.connectionID { loading = false } }
        do {
            let result = try await api.file(path: path, conversation: model.conversation)
            guard !Task.isCancelled, model.connectionID == connection else { return }
            file = result
            draft = result.content ?? ""
            savedContent = draft
            contentReady = true
            error = nil
        } catch {
            guard !Task.isCancelled, model.connectionID == connection else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else { self.error = WorkspaceFormat.error(error) }
        }
    }

    @MainActor private func save() async {
        guard valid, !busy, let api = model.api else { return }
        let connection = model.connectionID
        busy = true
        error = nil
        defer { if model.connectionID == connection { busy = false } }
        do {
            let result = try await api.saveFile(path: path, content: draft,
                expectedRevision: file?.revision, conversation: model.conversation)
            guard !Task.isCancelled, model.connectionID == connection else { return }
            file = result
            path = result.path
            draft = result.content ?? draft
            savedContent = draft
            saved = true
            onChanged()
        } catch {
            guard !Task.isCancelled, model.connectionID == connection else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else {
                self.error = WorkspaceFormat.error(error)
                conflict = (error as? APIError)?.isConflict == true
            }
        }
    }

    @MainActor private func remove() async {
        guard !busy, let file, let api = model.api else { return }
        let connection = model.connectionID
        busy = true
        defer { if model.connectionID == connection { busy = false } }
        do {
            try await api.deleteFile(path: file.path, expectedRevision: file.revision, conversation: model.conversation)
            guard !Task.isCancelled, model.connectionID == connection else { return }
            onChanged()
            dismiss()
        } catch {
            guard !Task.isCancelled, model.connectionID == connection else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else {
                self.error = WorkspaceFormat.error(error)
                conflict = (error as? APIError)?.isConflict == true
            }
        }
    }
}

private struct WorkspaceFilePreviewView: View {
    @Environment(\.dismiss) private var dismiss
    let document: WorkspacePreviewRequest

    private var isMarkdown: Bool {
        ["md", "markdown"].contains((document.path as NSString).pathExtension.lowercased())
    }

    var body: some View {
        ScrollView {
            if isMarkdown {
                MarkdownView(text: document.text).padding()
            } else {
                Text(document.text)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
        }
        .navigationTitle(document.path.isEmpty ? "File preview" : document.path)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
    }
}
