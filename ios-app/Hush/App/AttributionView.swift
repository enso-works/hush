import HushKit
import SwiftUI

/// Where installs came from, as Apple reports it: the postbacks an ad's
/// winning network gets (copies of them), App Store Connect's campaign
/// reports, and the conversion values the catalog defines. All aggregate: no
/// row is a person or an install.
struct AttributionView: View {
    let data: AppData
    @State private var part = Part.ads

    enum Part: String, CaseIterable { case ads = "Ads", store = "App Store", values = "Values" }

    var body: some View {
        AppScreen(data: data, title: "Attribution", screen: "app_attribution") { scope, key in
            Picker("Source", selection: $part) {
                ForEach(Part.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            Remote(key: key, height: 240) {
                try await data.client.attribution(data.slug, scope)
            } content: { a in
                switch part {
                case .ads: Postbacks(a: a, env: scope.env)
                case .store: StoreCampaigns(a: a)
                case .values: Milestones(list: a.conversionValues)
                }
            }
            if scope.channel != nil, part != .values {
                Text("Apple's numbers are not split by build channel: the channel filter does not apply here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct Postbacks: View {
    let a: AttributionAnswer
    let env: Env

    var body: some View {
        let p = a.postbacks
        if p.campaigns.isEmpty {
            Panel(title: "Ad postbacks") {
                EmptyNote("No postbacks in this period. The app's Info.plist sends copies to hush's domain (NSAdvertisingAttributionReportEndpoint, AdAttributionKit's AttributionCopyEndpoint), and each arrives a day or two after an ad's install window closes."
                    + (p.unverified > 0 ? " \(p.unverified) arrived that did not verify with Apple's keys, and are not counted." : ""))
            }
        } else {
            Panel(title: "Ad campaigns", trailing: "Installs") {
                VStack(spacing: 0) {
                    ForEach(Array(p.campaigns.enumerated()), id: \.offset) { i, c in
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.network).font(.subheadline.weight(.semibold))
                                Text("\(c.sourceIdentifier ?? "–") · \(c.kind == "aak" ? "AdAttributionKit" : "SKAdNetwork")")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(c.installs, format: .number).font(.subheadline.weight(.semibold).monospacedDigit())
                                Text("\(c.redownloads.formatted()) redownloads · \(c.views.formatted()) from a view")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        if i < p.campaigns.count - 1 { Divider().padding(.vertical, 10) }
                    }
                }
                if p.unverified > 0 {
                    Text("\(p.unverified) more did not verify with Apple's keys and are not counted.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            let firsts = p.values.filter { $0.sequence == 0 }
            Panel(title: "How far they got", trailing: "Days 0 to 2") {
                Bars(rows: firsts.map { v in
                    let label = v.conversionValue.map { a.milestone($0) } ?? v.coarseValue.map { "\($0) (coarse)" } ?? "Not reported"
                    return Bars.Row(id: "\(v.conversionValue ?? -1)-\(v.coarseValue ?? "")", label: label, value: v.n,
                                    detail: v.conversionValue.map { "value \($0)" }, muted: v.conversionValue == nil && v.coarseValue == nil)
                })
                Text("The highest milestone each install reached in the first window. Not reported: a campaign too small for Apple to say.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        if env == .dev {
            Text("Dev shows Apple's test postbacks (the developer tool), never real ones.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct StoreCampaigns: View {
    let a: AttributionAnswer
    private static let columns: [(key: String, label: String, money: Bool)] = [
        ("impressions", "Impressions", false), ("page_views", "Page views", false), ("first_downloads", "First downloads", false),
        ("redownloads", "Redownloads", false), ("sessions", "Sessions", false), ("purchases", "Purchases", false),
        ("proceeds_usd", "Proceeds", true),
    ]

    var body: some View {
        let s = a.appstore
        Panel(title: "App Store campaigns", trailing: "By ct") {
            if a.appStoreId == nil {
                EmptyNote("Add the app's app_store_id to the catalog to read its App Store campaigns.")
            } else if !s.configured, s.campaigns.isEmpty {
                EmptyNote("Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY on the server to import App Store Connect's campaign reports.")
            } else if let error = s.request?.lastError {
                Text("App Store Connect: \(error)").font(.callout).foregroundStyle(.red)
            } else if s.campaigns.isEmpty {
                EmptyNote((s.request.map { "Report request made \(when($0.createdAt)); Apple has the first data a day or two later." } ?? "Waiting for the first sync.")
                    + " Campaigns show once they have five first-time downloads.")
            } else {
                let cols = Self.columns.filter { c in s.campaigns.contains { $0[c.key].flatMap(number) != nil } }
                VStack(spacing: 0) {
                    ForEach(Array(s.campaigns.enumerated()), id: \.offset) { i, row in
                        VStack(alignment: .leading, spacing: 10) {
                            let name = row["campaign"].map(\.description) ?? ""
                            Text(name.isEmpty ? "No campaign" : name)
                                .font(name.isEmpty ? .subheadline.italic() : .subheadline.monospaced().weight(.semibold))
                                .foregroundStyle(name.isEmpty ? .secondary : .primary)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 10, alignment: .leading)], alignment: .leading, spacing: 10) {
                                ForEach(cols, id: \.key) { c in
                                    Figure(label: c.label, value: value(row[c.key], money: c.money))
                                }
                            }
                        }
                        if i < s.campaigns.count - 1 { Divider().padding(.vertical, 10) }
                    }
                }
                Text("Apple's numbers through \(s.latestDay ?? "–"), synced \(when(s.request?.lastSync)): users who share analytics with developers, under five hidden, with noise added.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func number(_ v: JSONValue) -> Double? {
        if case .number(let n) = v { return n }
        return nil
    }

    private func value(_ v: JSONValue?, money: Bool) -> String {
        guard let n = v.flatMap(number) else { return "–" }
        return money ? n.formatted(.currency(code: "USD").precision(.fractionLength(0))) : Int(n).formatted()
    }
}

private struct Milestones: View {
    let list: [AttributionAnswer.Milestone]

    var body: some View {
        Panel(title: "Conversion values", trailing: "From the catalog") {
            if list.isEmpty {
                EmptyNote("No conversion values in the catalog: postbacks will carry 0 (installed) and nothing more.")
            } else {
                VStack(spacing: 0) {
                    row(value: 0, coarse: "low", label: "Installed", event: "first launch", lock: false)
                    ForEach(list, id: \.value) { m in
                        Divider().padding(.vertical, 8)
                        row(value: m.value, coarse: m.coarse, label: m.label,
                            event: ([m.event] + (m.where ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }).joined(separator: " "),
                            lock: m.lock)
                    }
                }
                Text("The SDK sets these as they happen, and never lowers one. Enter the same table in the ad network so it reads the values the way hush does.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func row(value: Int, coarse: String, label: String, event: String, lock: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(value, format: .number).font(.subheadline.monospacedDigit().weight(.semibold)).frame(minWidth: 28, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(lock ? "\(label) (ends the window)" : label).font(.subheadline)
                Text(event).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            Spacer()
            Text(coarse).font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
