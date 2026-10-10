// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "IsobotCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "IsobotCore", targets: ["IsobotCore"])],
    targets: [
        .target(name: "IsobotCore", path: "Isobot", exclude: ["App", "Features", "Shared", "Info.plist", "Assets.xcassets"], sources: ["Models", "Networking"]),
        .testTarget(name: "IsobotCoreTests", dependencies: ["IsobotCore"])
    ]
)
