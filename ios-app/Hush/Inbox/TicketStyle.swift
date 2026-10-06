import HushKit
import SwiftUI

// The words, symbols and colours for a ticket's kind and status, as the web
// dashboard's Feedback page has them.

extension TicketKind {
    var label: String {
        switch self {
        case .issue: "Issue"
        case .feature: "Idea"
        case .love: "Love"
        case .other(let raw): eventLabel(raw)
        }
    }

    /// The filter menu's plural.
    var plural: String {
        switch self {
        case .issue: "Issues"
        case .feature: "Ideas"
        case .love: "Love"
        case .other(let raw): eventLabel(raw)
        }
    }

    var symbol: String {
        switch self {
        case .issue: "ladybug"
        case .feature: "lightbulb"
        case .love: "heart"
        case .other: "bubble.left"
        }
    }

    var tint: Color {
        switch self {
        case .issue: .red
        case .feature: .orange
        case .love: .pink
        case .other: .secondary
        }
    }
}

extension TicketStatus {
    var label: String {
        switch self {
        case .open: "Open"
        case .answered: "Answered"
        case .closed: "Closed"
        case .other(let raw): eventLabel(raw)
        }
    }

    var tint: Color {
        switch self {
        case .open: .accentColor
        case .answered: .green
        case .closed, .other: .secondary
        }
    }
}

/// The kind as a small coloured symbol on a tinted circle.
struct KindBadge: View {
    let kind: TicketKind
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 30

    var body: some View {
        Image(systemName: kind.symbol)
            .font(.system(size: side * 0.45, weight: .semibold))
            .foregroundStyle(kind.tint)
            .frame(width: side, height: side)
            .background(kind.tint.opacity(0.14), in: .circle)
            .accessibilityLabel(kind.label)
    }
}

/// The status, in a capsule.
struct StatusPill: View {
    let status: TicketStatus

    var body: some View {
        Text(status.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(status.tint)
            .background(status.tint.opacity(0.14), in: .capsule)
    }
}
