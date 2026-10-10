import SwiftUI

/// Native, selectable Markdown blocks; no remote HTML or JavaScript is executed.
struct MarkdownView: View {
    let text: String
    private var blocks: [MarkdownBlock] { MarkdownBlock.parse(text) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let value): inline(value)
                case .heading(let value, let level):
                    inline(value).font(level == 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline)
                case .code(let value, let language):
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(language.isEmpty ? "Code" : language).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button { UIPasteboard.general.string = value } label: { Label("Copy", systemImage: "doc.on.doc").font(.caption) }
                                .frame(minHeight: 44)
                        }
                        ScrollView(.horizontal) { Text(value).font(.system(.callout, design: .monospaced)).textSelection(.enabled) }
                    }
                    .padding(12).background(PiTheme.background, in: RoundedRectangle(cornerRadius: 12))
                case .quote(let value):
                    HStack(alignment: .top, spacing: 12) { Rectangle().fill(PiTheme.accent.opacity(0.5)).frame(width: 3); inline(value).foregroundStyle(.secondary) }
                case .list(let values):
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                            HStack(alignment: .firstTextBaseline, spacing: 10) { Text(value.0).foregroundStyle(.secondary); inline(value.1) }
                        }
                    }
                case .table(let rows):
                    ScrollView(.horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                                GridRow {
                                    ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in inline(cell).fontWeight(index == 0 ? .semibold : .regular) }
                                }
                                if index == 0 { Divider().gridCellColumns(rows.first?.count ?? 1) }
                            }
                        }.padding(12)
                    }.background(PiTheme.background, in: RoundedRectangle(cornerRadius: 12))
                case .rule: Divider()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func inline(_ value: String) -> some View {
        Text((try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value))
            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
}

private enum MarkdownBlock {
    case paragraph(String), heading(String, Int), code(String, String), quote(String), list([(String, String)]), table([[String]]), rule

    static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.components(separatedBy: .newlines)
        var blocks: [MarkdownBlock] = []
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { index += 1; continue }
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                let fence = String(line.prefix(3)); let language = String(line.dropFirst(3))
                index += 1; var code: [String] = []
                while index < lines.count, !lines[index].hasPrefix(fence) { code.append(lines[index]); index += 1 }
                blocks.append(.code(code.joined(separator: "\n"), language)); if index < lines.count { index += 1 }; continue
            }
            if line.hasPrefix("#"), let space = line.firstIndex(of: " ") {
                let prefix = line[..<space]
                if prefix.allSatisfy({ $0 == "#" }), prefix.count <= 6 { blocks.append(.heading(String(line[line.index(after: space)...]), prefix.count)); index += 1; continue }
            }
            if ["---", "***", "___"].contains(line.trimmingCharacters(in: .whitespaces)) { blocks.append(.rule); index += 1; continue }
            if line.hasPrefix(">") {
                var quote: [String] = []
                while index < lines.count, lines[index].hasPrefix(">") { quote.append(String(lines[index].dropFirst()).trimmingCharacters(in: .whitespaces)); index += 1 }
                blocks.append(.quote(quote.joined(separator: "\n"))); continue
            }
            if index + 1 < lines.count, line.contains("|"), isTableSeparator(lines[index + 1]) {
                var rows = [cells(line)]; index += 2
                while index < lines.count, lines[index].contains("|"), !lines[index].isEmpty { rows.append(cells(lines[index])); index += 1 }
                blocks.append(.table(rows)); continue
            }
            if listItem(line) != nil {
                var items: [(String, String)] = []
                while index < lines.count, let item = listItem(lines[index]) { items.append(item); index += 1 }
                blocks.append(.list(items)); continue
            }
            var paragraph = [line]; index += 1
            while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                  !lines[index].hasPrefix("#"), !lines[index].hasPrefix("```"), !lines[index].hasPrefix("~~~"),
                  !lines[index].hasPrefix(">"), listItem(lines[index]) == nil {
                paragraph.append(lines[index]); index += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return blocks
    }

    private static func cells(_ line: String) -> [String] {
        var parts = line.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.first?.isEmpty == true { parts.removeFirst() }
        if parts.last?.isEmpty == true { parts.removeLast() }
        return parts
    }
    private static func isTableSeparator(_ line: String) -> Bool {
        let parts = cells(line)
        return !parts.isEmpty && parts.allSatisfy { $0.replacingOccurrences(of: ":", with: "").allSatisfy { $0 == "-" } && $0.contains("---") }
    }
    private static func listItem(_ line: String) -> (String, String)? {
        let value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("- ") || value.hasPrefix("* ") || value.hasPrefix("+ ") {
            let text = String(value.dropFirst(2))
            if text.hasPrefix("[x] ") || text.hasPrefix("[X] ") { return ("☑", String(text.dropFirst(4))) }
            if text.hasPrefix("[ ] ") { return ("☐", String(text.dropFirst(4))) }
            return ("•", text)
        }
        if let range = value.range(of: "^[0-9]+[.)] ", options: .regularExpression) { return (String(value[range]).trimmingCharacters(in: .whitespaces), String(value[range.upperBound...])) }
        return nil
    }
}

#Preview { ScrollView { MarkdownView(text: "## A conversation with Pi\n\n**Markdown**, a [link](https://isolated.tech), and `code`.\n\n- [x] Save a file\n- [ ] Review a capture\n\n```swift\nlet context = \"durable\"\n```\n\n| Feature | Status |\n| --- | --- |\n| Chat | Ready |\n").padding() } }
