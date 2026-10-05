import Foundation
import HushKit
import SwiftUI

/// Stand-ins shaped like real answers, shown redacted while the first one
/// loads, so the screen has its layout from the first frame and the content
/// takes the place of its outline instead of popping in.
enum Placeholder {
    static let apps: AppsAnswer = decode("""
    {"install_retention_days": null, "apps": [\(app("a")), \(app("b"))]}
    """)

    static let detail: AppDetail = {
        let days = (0..<30).map { i in
            let active = 40 + Int(18 * sin(Double(i) / 4)) + i
            return #"{"day": "2026-01-\#(String(format: "%02d", i + 1))", "new_installs": \#(active / 4), "active": \#(active), "sessions": \#(active * 2)}"#
        }
        let period = #"{"new_installs": 100, "sessions": 1000, "active": 300, "highlight": 500, "highlight_done": 400}"#
        let retained = #"{"cohort": 100, "retained": 40}"#
        return decode("""
        {"app": "app", "name": "App", "channel": null, "channels": [], "highlight": null,
         "current": \(period), "prior": \(period),
         "retention": {"d1": \(retained), "d7": \(retained), "d30": \(retained)},
         "engagement": null, "todayActive": 50, "daily": [\(days.joined(separator: ","))],
         "versions": [{"version": "1.0.0", "installs": 200}, {"version": "0.9.0", "installs": 90}],
         "events": [], "countries": [{"country": "US", "installs": 120}, {"country": "DE", "installs": 80}],
         "tickets": 0, "lastEvent": null}
        """)
    }()

    private static func app(_ slug: String) -> String {
        let trend = (0..<30).map { String(20 + Int(10 * sin(Double($0) / 3)) + $0) }.joined(separator: ",")
        return #"{"app": "\#(slug)", "name": "Application", "new_installs": 100, "total_installs": 1000, "dau": 100, "wau": 300, "mau": 600, "sessions": 1000, "events": 5000, "open_tickets": 0, "last_event": null, "ad_installs": 0, "trend": [\#(trend)]}"#
    }

    private static func decode<T: Decodable>(_ json: String) -> T {
        do {
            return try JSONDecoder().decode(T.self, from: Data(json.utf8))
        } catch {
            preconditionFailure("A placeholder no longer matches its model: \(error)")
        }
    }
}

extension View {
    /// A loading stand-in: redacted, still, and read as one "Loading" element.
    func placeholder(_ active: Bool) -> some View {
        redacted(reason: active ? .placeholder : [])
            .allowsHitTesting(!active)
            .accessibilityElement(children: active ? .ignore : .contain)
            .accessibilityLabel(active ? Text("Loading") : Text(""))
    }
}

/// How the screen changes when an answer arrives: a short spring that settles
/// without a bounce, so numbers roll and charts morph to their new values;
/// with Reduce Motion, a cross-fade.
func arrival(reduceMotion: Bool) -> Animation {
    reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.35)
}

/// The accent, or a neutral grey on a placeholder: a stand-in for a chart is not one.
func accent(_ redaction: RedactionReasons) -> Color {
    redaction.isEmpty ? .accentColor : Color(.systemFill)
}
