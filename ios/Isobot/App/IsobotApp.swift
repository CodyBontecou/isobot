import SwiftUI

@main
struct IsobotApp: App {
    @State private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(PiTheme.accent)
                .task { await model.restore() }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Group {
            if model.api != nil {
                TabView {
                    NavigationStack { ChatView() }
                        .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
                    NavigationStack { WorkspaceView() }
                        .tabItem { Label("Workspace", systemImage: "folder") }
                    NavigationStack { AccountView() }
                        .tabItem { Label("Account", systemImage: "person.crop.circle") }
                }
            } else {
                SignInView()
            }
        }
        .task(id: "\(model.connectionID)-\(scenePhase)-\(model.busy)") {
            guard scenePhase == .active, model.api != nil else { return }
            await model.watchConversation()
        }
    }
}

#if DEBUG
#Preview("Workspace") {
    RootView().environment(AppModel(client: try? PreviewServer.makeClient(), user: PreviewServer.user))
}
#Preview("Sign in") {
    SignInView().environment(AppModel())
}
#endif
