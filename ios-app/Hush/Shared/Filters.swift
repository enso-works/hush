import HushKit
import SwiftUI

/// The filters above a screen of numbers, as chips that say what is shown:
/// the period and the data, kept between launches, and what else the screen
/// adds (a channel, an order). A chip off its default is filled, and Reset
/// brings them all back.
struct FilterBar<Extra: View>: View {
    /// Whether the extra chips are off their defaults, for Reset.
    var extraActive = false
    var reset: () -> Void = {}
    @ViewBuilder var extra: Extra

    @AppStorage("days") private var days = 30
    @AppStorage("env") private var env = Env.prod

    var body: some View {
        let active = days != 30 || env != .prod || extraActive
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                // First, so it is in view however many chips follow.
                if active {
                    Button {
                        days = 30
                        env = .prod
                        reset()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.subheadline.weight(.semibold))
                            .padding(9)
                            .background(Color(.tertiarySystemFill), in: .circle)
                            .contentShape(.circle)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Reset")
                    .transition(.scale.combined(with: .opacity))
                }
                Menu {
                    Picker("Period", selection: $days) {
                        ForEach(Prefs.periods, id: \.self) { Text(Prefs.periodName($0)).tag($0) }
                    }
                } label: {
                    Chip(title: Prefs.periodName(days), symbol: "calendar", active: days != 30)
                }
                .accessibilityLabel("Period, \(Prefs.periodName(days))")
                Menu {
                    Picker("Data", selection: $env) {
                        Label("Release builds", systemImage: "app.badge.checkmark").tag(Env.prod)
                        Label("Development builds", systemImage: "hammer").tag(Env.dev)
                    }
                } label: {
                    Chip(title: env == .prod ? "Release builds" : "Development", symbol: env == .prod ? "app.badge.checkmark" : "hammer", active: env != .prod)
                }
                .accessibilityLabel("Data, \(env == .prod ? "release builds" : "development builds")")
                extra
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .animation(.smooth(duration: 0.25), value: active)
        }
        .scrollIndicators(.hidden)
        .sensoryFeedback(.selection, trigger: days)
        .sensoryFeedback(.selection, trigger: env)
    }
}

extension FilterBar where Extra == EmptyView {
    init() { self.init(extra: { EmptyView() }) }
}

/// One filter's current value, as the label of the menu that changes it.
struct Chip: View {
    let title: String
    var symbol: String? = nil
    var active = false

    var body: some View {
        HStack(spacing: 5) {
            if let symbol { Image(systemName: symbol).imageScale(.small) }
            Text(title).lineLimit(1)
            Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).imageScale(.small)
        }
        .font(.subheadline.weight(active ? .semibold : .regular))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .foregroundStyle(active ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
        .background(active ? AnyShapeStyle(.tint.opacity(0.14)) : AnyShapeStyle(Color(.tertiarySystemFill)), in: .capsule)
        .contentShape(.capsule)
    }
}

/// The channel chip: shown when an app's installs come from more than one
/// build channel, or one is picked.
struct ChannelChip: View {
    @Binding var channel: String?
    let channels: [AppDetail.Channel]

    var body: some View {
        Menu {
            Picker("Build channel", selection: $channel) {
                Text("All channels").tag(String?.none)
                ForEach(channels, id: \.channel) { c in
                    Text("\(channelName(c.channel)) (\(c.installs.formatted()))").tag(Optional(c.channel))
                }
            }
        } label: {
            Chip(title: channel.map(channelName) ?? "All channels", symbol: "shippingbox", active: channel != nil)
        }
        .accessibilityLabel("Build channel, \(channel.map(channelName) ?? "all")")
        .sensoryFeedback(.selection, trigger: channel)
    }
}

/// `app_store` as `App Store`, `testflight` as `TestFlight`.
func channelName(_ channel: String) -> String {
    switch channel {
    case "app_store": "App Store"
    case "testflight": "TestFlight"
    case "play": "Google Play"
    default: eventLabel(channel)
    }
}
