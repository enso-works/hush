import Charts
import SwiftUI

/// Values over time, without axes: the shape is the point.
struct Sparkline: View {
    let values: [Int]

    var body: some View {
        Chart(Array(values.enumerated()), id: \.offset) { i, v in
            AreaMark(x: .value("Day", i), y: .value("Installs", v))
                .foregroundStyle(.linearGradient(colors: [.accentColor.opacity(0.3), .accentColor.opacity(0)], startPoint: .top, endPoint: .bottom))
                .interpolationMethod(.monotone)
            LineMark(x: .value("Day", i), y: .value("Installs", v))
                .foregroundStyle(Color.accentColor)
                .lineStyle(StrokeStyle(lineWidth: 1.5))
                .interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: 0...max(values.max() ?? 1, 1))
        .accessibilityLabel("Active installs per day")
    }
}
