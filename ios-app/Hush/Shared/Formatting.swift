import Foundation
import SwiftUI

/// The dashboard's period and data choices, kept between launches and shared
/// by every screen, as the web dashboard keeps them.
enum Prefs {
    static let periods = [7, 30, 90, 365]

    static func periodLabel(_ days: Int) -> String {
        days == 365 ? "1y" : "\(days)d"
    }
}

/// When something last happened, as the web dashboard says it.
func when(_ date: Date?, now: Date = .now) -> String {
    guard let date else { return "never" }
    let s = now.timeIntervalSince(date)
    if s < 90 { return "just now" }
    if s < 5400 { return "\(Int((s / 60).rounded())) min ago" }
    if s < 172_800 { return "\(Int((s / 3600).rounded())) h ago" }
    return date.formatted(date: .abbreviated, time: .omitted)
}

/// `meditation_completed` as `Meditation completed`.
nonisolated func eventLabel(_ name: String) -> String {
    let words = name.split(separator: "_").joined(separator: " ")
    return words.prefix(1).uppercased() + words.dropFirst()
}

/// The change against the period before, or nil when there is nothing to compare with.
func change(_ current: Int, _ prior: Int) -> Double? {
    prior > 0 ? Double(current - prior) / Double(prior) : nil
}

/// A `YYYY-MM-DD` day from the server, as a date at its start in UTC.
func day(_ s: String) -> Date? {
    try? Date(s + "T00:00:00Z", strategy: .iso8601)
}

/// A two-letter country code as its flag, or nil for `other`.
func flag(_ country: String) -> String? {
    guard country.count == 2, country.allSatisfy(\.isLetter) else { return nil }
    return String(country.uppercased().unicodeScalars.compactMap { UnicodeScalar(127_397 + $0.value) }.map(Character.init))
}

/// 7d, 30d, 90d, 1y: the period every screen counts over.
struct PeriodPicker: View {
    @Binding var days: Int

    var body: some View {
        Picker("Period", selection: $days) {
            ForEach(Prefs.periods, id: \.self) { Text(Prefs.periodLabel($0)).tag($0) }
        }
        .pickerStyle(.segmented)
    }
}
