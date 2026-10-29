import HushKit
import SwiftUI

/// A website's pages: what was read, where visits came from, and the clicks
/// that left for a store or another site (SDK 2.5's `autoTrack`, or the
/// `/hush.js` tag). A page is a `screen_viewed` with its path.
struct WebsiteView: View {
    let data: AppData

    var body: some View {
        AppScreen(data: data, title: "Pages", screen: "app_website") { scope, key in
            Panel(title: "Top pages", trailing: "Pageviews") {
                Remote(key: key) {
                    try await data.client.breakdown(data.slug, event: "screen_viewed", prop: "screen", scope)
                } content: { rows in
                    BreakdownBars(rows: rows, empty: "No pageviews in this period. autoTrack, or the /hush.js tag, records one for every page.",
                                  taggedOnly: true, noun: "visitor", code: true)
                }
            }
            Panel(title: "Referrers", trailing: "Visits") {
                Remote(key: key) {
                    try await data.client.breakdown(data.slug, event: "session_started", prop: "referrer", scope)
                } content: { rows in
                    BreakdownBars(rows: rows, empty: "No visits from other sites in this period.", taggedOnly: true, noun: "visitor", code: true)
                }
                Text("The site each visit came from, as its host only. A visit typed in, from a bookmark or from an app has none.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Panel(title: "Store clicks", trailing: "Clicks") {
                Remote(key: key) {
                    try await data.client.breakdown(data.slug, event: "store_clicked", prop: "store", scope)
                } content: { rows in
                    BreakdownBars(rows: rows, empty: "No clicks on App Store, TestFlight or Google Play links in this period.", noun: "visitor")
                }
            }
            Panel(title: "Store clicks by campaign", trailing: "Clicks") {
                Remote(key: key) {
                    try await data.client.breakdown(data.slug, event: "store_clicked", prop: "campaign", scope)
                } content: { rows in
                    BreakdownBars(rows: rows, empty: "No store clicks in this period.", noun: "visitor", code: true)
                }
                Text("The visit's campaign, the same one hush.storeLink puts in an App Store link's ct, so App Store Connect counts it too. None: a visit without a tagged link.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Panel(title: "Links out", trailing: "Clicks") {
                Remote(key: key) {
                    try await data.client.breakdown(data.slug, event: "link_clicked", prop: "host", scope)
                } content: { rows in
                    BreakdownBars(rows: rows, empty: "No clicks on links to other sites in this period.", noun: "visitor", code: true)
                }
            }
        }
    }
}
