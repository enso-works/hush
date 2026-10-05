import Charts
import SwiftUI

/// Values over time, without axes: the shape is the point.
struct Sparkline: View {
    let values: [Int]
    @Environment(\.redactionReasons) private var redaction

    var body: some View {
        let tint = accent(redaction)
        Chart(Array(values.enumerated()), id: \.offset) { i, v in
            AreaMark(x: .value("Day", i), y: .value("Installs", v))
                .foregroundStyle(.linearGradient(colors: [tint.opacity(0.3), tint.opacity(0)], startPoint: .top, endPoint: .bottom))
                .interpolationMethod(.monotone)
            LineMark(x: .value("Day", i), y: .value("Installs", v))
                .foregroundStyle(tint)
                .lineStyle(StrokeStyle(lineWidth: 1.5))
                .interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: 0...max(values.max() ?? 1, 1))
        .accessibilityLabel("Active installs per day")
    }
}
