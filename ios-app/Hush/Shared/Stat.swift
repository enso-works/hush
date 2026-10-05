import SwiftUI

/// One number in a tile, with its change against the period before.
struct Stat: View {
    let label: String
    let value: String
    var change: Double? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            HStack(alignment: .firstTextBaseline) {
                Text(value)
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .contentTransition(reduceMotion ? .opacity : .numericText())
                Spacer(minLength: 4)
                if let change {
                    Text(change, format: .percent.precision(.fractionLength(0)).sign(strategy: .always()))
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(change >= 0 ? .green : .red)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
    }
}

/// A chart or list in a rounded box, with its title.
struct Panel<Content: View>: View {
    let title: String
    var trailing: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                if let trailing {
                    Text(trailing).font(.caption).foregroundStyle(.secondary)
                }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16))
    }
}
