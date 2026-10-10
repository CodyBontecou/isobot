import SwiftUI

struct WorkspaceResourcesView: View {
    @Environment(AppModel.self) private var model
    @State private var data: ResourceSnapshot?
    @State private var error: String?
    @State private var loading = false
    @State private var loadID = UUID()

    var body: some View {
        List {
            if let error {
                WorkspaceErrorView(message: error) { Task { await load() } }
            }
            if let data {
                runtime(data.runtime)
                storage(data.storage, pricing: data.pricing)
                usage(data.usage)
                pricing(data.pricing)
                Section("Connected resources") {
                    ForEach(data.bindings) { binding in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Label(binding.name, systemImage: "externaldrive.connected.to.line.below")
                                    .font(.headline)
                                Spacer()
                                Text(binding.kind).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(binding.description).font(.callout).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                    if data.bindings.isEmpty { Text("No connected resources.").foregroundStyle(.secondary) }
                }
                Section {
                    DisclosureGroup("How these numbers are measured") {
                        ForEach(Array(data.pricing.notes.enumerated()), id: \.offset) { _, note in
                            Text(note).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                }
            } else if loading {
                ProgressView("Reading agent resources…").frame(maxWidth: .infinity)
            }
        }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh resources", systemImage: "arrow.clockwise") { Task { await load() } }
                    .labelStyle(.iconOnly).disabled(loading)
            }
        }
        .task(id: model.connectionID) {
            data = nil
            error = nil
            await load()
        }
    }

    private func runtime(_ runtime: ResourceRuntime) -> some View {
        Section("Durable agent") {
            VStack(alignment: .leading, spacing: 6) {
                Text(runtime.model).font(.headline).textSelection(.enabled)
                Text(runtime.provider == "workers-ai" ? "Cloudflare Workers AI" : runtime.provider)
                    .font(.callout).foregroundStyle(.secondary)
            }
            LabeledContent("Harness", value: runtime.harness)
            LabeledContent {
                Label(runtime.busy ? "Working" : "Ready", systemImage: runtime.busy ? "hourglass" : "checkmark.circle.fill")
                    .foregroundStyle(runtime.busy ? .orange : .green)
            } label: { Text("Status") }
            metric("Pending requests", runtime.pendingCount)
            metric("Sessions", runtime.sessionCount)
        }
    }

    private func storage(_ storage: ResourceStorage, pricing: ResourcePricing) -> some View {
        Section {
            LabeledContent("Durable database", value: WorkspaceFormat.bytes(storage.databaseBytes))
            LabeledContent("Workspace", value: WorkspaceFormat.bytes(storage.workspaceBytes))
            metric("Workspace files", storage.workspaceFiles)
            metric("Saved captures", storage.captures)
            LabeledContent("Gross storage / month", value: WorkspaceFormat.money(pricing.storageEstimateUSDPerMonth))
        } header: { Text("Storage in this conversation") } footer: {
            Text("Storage estimate uses the current database size and published rate, before account allowances.")
        }
    }

    private func usage(_ usage: ResourceUsage) -> some View {
        Section {
            Text(usage.scope).font(.callout).foregroundStyle(.secondary)
            metric("Input tokens", usage.inputTokens)
            metric("Output tokens", usage.outputTokens)
            metric("Cached input tokens", usage.cacheReadTokens)
            metric("Cache write tokens", usage.cacheWriteTokens)
            metric("Total tokens", usage.totalTokens)
            LabeledContent("Pi catalog estimate", value: WorkspaceFormat.money(usage.recordedCatalogEstimateUSD))
            if !usage.models.isEmpty {
                DisclosureGroup("Usage by model") {
                    ForEach(usage.models) { model in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(model.key).font(.headline).textSelection(.enabled)
                            Text("\(model.totalTokens.formatted()) tokens · \(WorkspaceFormat.money(model.recordedCatalogEstimateUSD)) catalog estimate")
                                .font(.callout).foregroundStyle(.secondary)
                            Text("\(model.inputTokens.formatted()) input · \(model.outputTokens.formatted()) output · \(model.cacheReadTokens.formatted()) cached input · \(model.cacheWriteTokens.formatted()) cache write")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        } header: { Text("Recorded model usage") } footer: {
            Text("Pi’s recorded estimate may differ from your provider bill. Your Cloudflare account bill is unavailable here.")
        }
    }

    private func pricing(_ pricing: ResourcePricing) -> some View {
        Section {
            Text("Checked \(pricing.checkedAt). Prices in \(pricing.currency).")
                .font(.caption).foregroundStyle(.secondary)
            sourceLink(pricing.model.label, source: pricing.model.source)
            if let input = pricing.model.inputPerMillion {
                LabeledContent("Input / 1M tokens", value: WorkspaceFormat.money(input))
                if let cached = pricing.model.cachedInputPerMillion {
                    LabeledContent("Cached input / 1M", value: WorkspaceFormat.money(cached))
                }
                if let output = pricing.model.outputPerMillion {
                    LabeledContent("Output / 1M tokens", value: WorkspaceFormat.money(output))
                }
            } else {
                Text("Token billing is unavailable for this provider.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(Array(pricing.rates.enumerated()), id: \.offset) { _, rate in
                VStack(alignment: .leading, spacing: 6) {
                    sourceLink(rate.label, source: rate.source)
                    Text("\(WorkspaceFormat.money(rate.usd)) \(rate.unit)").font(.callout)
                    if let included = rate.included {
                        Text(included).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
        } header: { Text("Published unit prices") } footer: {
            Text("Account allowances are shared across your applications.")
        }
    }

    private func metric(_ title: String, _ value: Int) -> some View {
        LabeledContent(title, value: value.formatted())
    }

    @ViewBuilder private func sourceLink(_ label: String, source: String) -> some View {
        if let url = URL(string: source), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
            Link(destination: url) { Label(label, systemImage: "arrow.up.right.square") }
        } else {
            Text(label)
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
            let result = try await api.resources(conversation: model.conversation)
            guard !Task.isCancelled, model.connectionID == connection, loadID == request else { return }
            data = result
            error = nil
        } catch {
            guard !Task.isCancelled, model.connectionID == connection, loadID == request else { return }
            if (error as? APIError)?.isUnauthorized == true { model.handle(error, connectionID: connection) }
            else { self.error = WorkspaceFormat.error(error) }
        }
    }
}
