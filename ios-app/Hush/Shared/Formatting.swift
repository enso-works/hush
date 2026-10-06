import Foundation
import SwiftUI

/// The dashboard's period and data choices, kept between launches and shared
/// by every screen, as the web dashboard keeps them.
enum Prefs {
    // No shorter period: a day has one point to chart.
    static let periods = [7, 14, 30, 90, 365]

    static func periodLabel(_ days: Int) -> String {
        days == 365 ? "1y" : "\(days)d"
    }

    /// The period as a filter names it.
    static func periodName(_ days: Int) -> String {
        days == 365 ? "Last year" : "Last \(days) days"
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

/// Seconds as the web dashboard says them: `45 s`, `3 min 20 s`, `1 h 5 min`.
func duration(_ seconds: Int?) -> String {
    guard let s = seconds else { return "–" }
    if s < 60 { return "\(s) s" }
    if s < 3600 {
        let rest = s % 60
        return rest > 0 ? "\(s / 60) min \(rest) s" : "\(s / 60) min"
    }
    let m = Int((Double(s % 3600) / 60).rounded())
    return m > 0 ? "\(s / 3600) h \(m) min" : "\(s / 3600) h"
}

/// `DE` as `Germany`, in the phone's language; `other` as `Other`.
func countryName(_ code: String) -> String {
    guard code.count == 2 else { return "Other" }
    return Locale.current.localizedString(forRegionCode: code.uppercased()) ?? code.uppercased()
}

/// A share as a whole percent: `48%`.
func percent(_ part: Int, of whole: Int) -> String {
    whole > 0 ? (Double(part) / Double(whole)).formatted(.percent.precision(.fractionLength(0))) : "–"
}

extension Date.FormatStyle {
    /// A server's days are UTC midnights: formatted in UTC, each stays the day it is.
    func utc() -> Self {
        var style = self
        style.timeZone = .gmt
        return style
    }
}
