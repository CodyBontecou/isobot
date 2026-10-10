import SwiftUI

enum PiTheme {
    static let accent = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.90, green: 0.65, blue: 0.44, alpha: 1) : UIColor(red: 0.73, green: 0.39, blue: 0.19, alpha: 1) })
    static let paper = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.11, green: 0.13, blue: 0.11, alpha: 1) : UIColor(red: 1, green: 0.996, blue: 0.98, alpha: 1) })
    static let background = Color(uiColor: .systemGroupedBackground)
}

struct PiMark: View {
    var size: CGFloat = 48
    var body: some View {
        Text("π")
            .font(.system(size: size * 0.82, weight: .bold, design: .serif))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(PiTheme.accent, in: RoundedRectangle(cornerRadius: size * 0.28))
            .accessibilityHidden(true)
    }
}

struct InlineError: View {
    var text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(.callout).foregroundStyle(.red)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityAddTraits(.updatesFrequently)
    }
}
