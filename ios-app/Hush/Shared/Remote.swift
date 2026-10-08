import HushKit
import SwiftUI

/// A part of a screen read on its own: read when it appears and whenever
/// `key` changes, the last answer kept on screen while the next is read, so
/// a filter change morphs the numbers instead of blanking them. A failed
/// read shows why in its place: numbers for other filters would mislead.
struct Remote<Key: Hashable, Value, Content: View>: View {
    let key: Key
    /// The height of the space kept while the first answer comes.
    var height: CGFloat = 120
    let load: () async throws -> Value
    @ViewBuilder let content: (Value) -> Content

    @State private var value: Value?
    @State private var error: HushError?
    /// Counts answers to animate on (see AppData.arrivals).
    @State private var arrivals = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let error {
                ErrorNote(error: error) { await run() }
            } else if let value {
                content(value)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: height)
            }
        }
        .animation(arrival(reduceMotion: reduceMotion), value: arrivals)
        .task(id: key) { await run() }
    }

    private func run() async {
        do {
            let fresh = try await load()
            value = fresh
            error = nil
            arrivals += 1
        } catch is CancellationError {
        } catch {
            // A read given up for a newer one fails as a URL error, not a cancellation.
            if !Task.isCancelled { self.error = HushError(error) }
        }
    }
}

/// A short line where a list or a chart would be, when there is nothing in it.
struct EmptyNote: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: 80)
    }
}
