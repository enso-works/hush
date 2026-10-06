import SwiftUI

/// Feedback the moment a finger lands on a card, not when it lifts: a small
/// scale on a critically damped spring, so it settles without a bounce and
/// can be reversed mid-way. With Reduce Motion, a dim instead.
struct Pressable: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed && reduceMotion ? 0.7 : 1)
            .animation(.spring(duration: 0.25, bounce: 0), value: configuration.isPressed)
    }
}

extension View {
    /// Controls kept at an edge while the content scrolls under them: the
    /// filters under the navigation bar, the reply field above the keyboard.
    /// On iOS 26 they join the bars' scroll edge effect; a material of their
    /// own there blurs the large title and draws a hard line. Before iOS 26
    /// they sit on the bar material.
    @ViewBuilder func pinnedBar<Bar: View>(_ edge: VerticalEdge, @ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: edge, spacing: 0) { bar() }
        } else {
            safeAreaInset(edge: edge, spacing: 0) { bar().background(.bar) }
        }
    }
}
