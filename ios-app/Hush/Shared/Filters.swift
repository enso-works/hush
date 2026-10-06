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

/// The filters as one line: `Last 30 days`, `Last 7 days · Development · TestFlight`.
func scopeLine(days: Int, env: Env, channel: String?) -> String {
    [Prefs.periodName(days), env == .dev ? "Development" : nil, channel.map(channelName)].compactMap(\.self).joined(separator: " · ")
}

extension View {
    /// The screen's filters under its title, so they show however far it is
    /// scrolled. iOS 26 has subtitles; before it, the title menu says them.
    @ViewBuilder func scopeSubtitle(_ line: String) -> some View {
        if #available(iOS 26, *) {
            navigationSubtitle(line)
        } else {
            self
        }
    }
}

/// The filters again, from the screen's title: in reach however far the
/// screen is scrolled, the chips at its top long gone.
struct ScopeMenu: View {
    @Bindable var data: AppData
    @AppStorage("days") private var days = 30
    @AppStorage("env") private var env = Env.prod

    var body: some View {
        Picker(selection: $days) {
            ForEach(Prefs.periods, id: \.self) { Text(Prefs.periodName($0)).tag($0) }
        } label: {
            Label("Period", systemImage: "calendar")
            Text(Prefs.periodName(days))
        }
        .pickerStyle(.menu)
        Picker(selection: $env) {
            Text("Release builds").tag(Env.prod)
            Text("Development builds").tag(Env.dev)
        } label: {
            Label("Data", systemImage: env == .prod ? "app.badge.checkmark" : "hammer")
            Text(env == .prod ? "Release builds" : "Development builds")
        }
        .pickerStyle(.menu)
        if let channels = data.detail?.channels, channels.count > 1 || data.channel != nil {
            Picker(selection: $data.channel) {
                Text("All channels").tag(String?.none)
                ForEach(channels, id: \.channel) { Text(channelName($0.channel)).tag(Optional($0.channel)) }
            } label: {
                Label("Build channel", systemImage: "shippingbox")
                Text(data.channel.map(channelName) ?? "All channels")
            }
            .pickerStyle(.menu)
        }
        if days != 30 || env != .prod || data.channel != nil {
            Button("Reset Filters", systemImage: "xmark") {
                days = 30
                env = .prod
                data.channel = nil
            }
        }
    }
}

extension View {
    /// An app screen's title: the filters under it, and in a menu on it.
    func scopeTitle(_ data: AppData, days: Int, env: Env) -> some View {
        scopeSubtitle(scopeLine(days: days, env: env, channel: data.channel))
            .toolbarTitleMenu { ScopeMenu(data: data) }
    }
}
