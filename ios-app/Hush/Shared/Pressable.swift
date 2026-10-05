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
