import SwiftUI

struct WorkspaceView: View {
    private enum Pane: String, CaseIterable, Identifiable {
        case files = "Files", captures = "Captures", resources = "Resources"
        var id: Self { self }
    }

    @State private var pane: Pane = .files

    var body: some View {
        VStack(spacing: 0) {
            Picker("Workspace section", selection: $pane) {
                ForEach(Pane.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            switch pane {
            case .files: WorkspaceFilesView()
            case .captures: WorkspaceCapturesView()
            case .resources: WorkspaceResourcesView()
            }
        }
        .navigationTitle("Workspace")
        .navigationBarTitleDisplayMode(.inline)
    }
}
