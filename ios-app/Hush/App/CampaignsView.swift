import HushKit
import SwiftUI

/// Where tagged links (an ad, a newsletter) brought people, and how far they
/// got: each install once, for its first tagged session in the period, then
/// a funnel's steps. A website's steps are its store clicks.
struct CampaignsView: View {
    let data: AppData

    var body: some View {
        AppScreen(data: data, title: "Campaigns", screen: "app_campaigns") { scope, key in
            CampaignsContent(data: data, scope: scope, key: key)
        }
    }
}

private struct CampaignsContent: View {
    let data: AppData
    let scope: Scope
    let key: AppData.Key
    @State private var split = CampaignSplit.campaign
    @State private var source: String?
    @State private var funnel = 0
    @State private var sources: [String] = []
    @State private var funnels: [Funnel] = []

    var body: some View {
        VStack(spacing: 16) {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    Menu {
                        Picker("Split by", selection: $split) {
                            ForEach(CampaignSplit.allCases, id: \.self) { Text(splitName($0)).tag($0) }
                        }
                    } label: {
                        Chip(title: splitName(split), symbol: "rectangle.split.3x1")
                    }
                    .accessibilityLabel("Split by, \(splitName(split))")
                    if split != .source, !sources.isEmpty {
                        Menu {
                            Picker("Source", selection: $source) {
                                Text("Every source").tag(String?.none)
                                ForEach(sources, id: \.self) { Text($0).tag(Optional($0)) }
                            }
                        } label: {
                            Chip(title: source ?? "Every source", symbol: "antenna.radiowaves.left.and.right", active: source != nil)
                        }
                    }
                    if !data.isWebsite, funnels.count > 1 {
                        Menu {
                            Picker("Funnel", selection: $funnel) {
                                ForEach(Array(funnels.enumerated()), id: \.offset) { i, f in Text(f.name).tag(i) }
                            }
                        } label: {
                            Chip(title: funnels[min(funnel, funnels.count - 1)].name, symbol: "line.3.horizontal.decrease")
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
            .scrollIndicators(.hidden)
            .padding(.horizontal, -16)
            .sensoryFeedback(.selection, trigger: split)

            Panel(title: splitName(split), trailing: data.isWebsite ? "Visitors" : "Installs") {
                Remote(key: [AnyHashable(key), AnyHashable(split), AnyHashable(source), AnyHashable(funnel)], height: 200) {
                    try await data.client.campaigns(data.slug, by: split, source: split == .source ? nil : source, funnel: funnel,
                                                    steps: data.isWebsite ? [StepQuery("store_clicked")] : [], scope)
                } content: { answer in
                    if answer.rows.isEmpty {
                        EmptyNote(split == .referrer
                            ? "No visits from other sites in this period. A website on SDK 2.5 with autoTrack, or the /hush.js tag, records the site each visit came from."
                            : "No sessions from tagged links in this period. Links need utm_ tags, and the app passes the link to entry('link', { url }).")
                    } else {
                        VStack(spacing: 0) {
                            ForEach(answer.rows) { row in
                                CampaignRow(row: row, steps: answer.steps, code: split == .referrer, noun: data.visitor)
                                if row.id != answer.rows.last?.id { Divider().padding(.vertical, 10) }
                            }
                        }
                    }
                }
            }
            Text(data.isWebsite
                ? "Each visitor counts once, for their first visit from a tagged link (or, split by referrer, from another site) in the period, then whether they clicked through to a store."
                : "Each install counts once, for its first session from a tagged link in the period, then the funnel's steps in order. On iOS a link only opens an app already installed, so there it measures coming back; new installs from an ad are Apple's to count, under Attribution.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: key) {
            let rows = try? await data.client.campaigns(data.slug, by: .source, steps: [StepQuery("session_started")], scope).rows
            if !Task.isCancelled { sources = rows?.map(\.value) ?? [] }
            if !data.isWebsite, let f = try? await data.client.funnels(data.slug, scope), !Task.isCancelled { funnels = f }
        }
    }

    private func splitName(_ s: CampaignSplit) -> String {
        switch s {
        case .source: "Source"
        case .campaign: "Campaign"
        case .adSet: "Ad set"
        case .ad: "Ad"
        case .referrer: "Referrer"
        }
    }
}

/// One tag value: its installs, the new ones, and each step with its share.
private struct CampaignRow: View {
    let row: CampaignsAnswer.Row
    let steps: [CampaignsAnswer.Step]
    /// A host, shown as sent.
    let code: Bool
    let noun: String
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(code ? row.value : row.value.replacingOccurrences(of: "_", with: " "))
                    .font(code ? .subheadline.monospaced().weight(.semibold) : .subheadline.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Text(plural(row.installs, noun)).font(.subheadline.monospacedDigit())
            }
            Text("\(row.new.formatted()) new: the link brought them")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(Array(zip(steps, row.steps).enumerated()), id: \.offset) { _, pair in
                let (step, n) = pair
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(step.label).font(.caption)
                        Spacer()
                        Text("\(n.formatted()) · \(percent(n, of: row.installs))").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    GeometryReader { g in
                        Capsule().fill(.quaternary)
                            .overlay(alignment: .leading) {
                                Capsule().fill(accent(redaction).opacity(0.75))
                                    .frame(width: max(3, g.size.width * CGFloat(n) / CGFloat(max(row.installs, 1))))
                            }
                    }
                    .frame(height: 6)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(step.label)
                .accessibilityValue("\(n), \(percent(n, of: row.installs))")
            }
        }
    }
}
