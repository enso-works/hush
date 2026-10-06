import Charts
import HushKit
import SwiftUI

/// Active installs, sessions or new installs per day. Touch and drag along
/// it to read any day; without a finger on it, the period's figure.
struct Activity: View {
    let daily: [AppDetail.Day]
    /// Days new installs count over, when the retention window is shorter than the period.
    let cut: Int?

    enum Metric: String, CaseIterable, Identifiable {
        case active, sessions, new
        var id: Self { self }

        var title: String {
            switch self {
            case .active: "Active installs"
            case .sessions: "Sessions"
            case .new: "New installs"
            }
        }

        var short: String {
            switch self {
            case .active: "Active"
            case .sessions: "Sessions"
            case .new: "New"
            }
        }

        func value(_ d: AppDetail.Day) -> Int {
            switch self {
            case .active: d.active
            case .sessions: d.sessions
            case .new: d.newInstalls
            }
        }
    }

    @AppStorage("activityMetric") private var metric = Metric.active
    @State private var selected: Date?
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.dynamicTypeSize) private var typeSize

    private struct Point: Identifiable {
        let date: Date
        let day: AppDetail.Day
        var id: Date { date }
    }

    private var points: [Point] {
        daily.compactMap { d in day(d.day).map { Point(date: $0, day: d) } }
    }

    var body: some View {
        let points = points
        let picked = selected.flatMap { s in points.min { abs($0.date.timeIntervalSince(s)) < abs($1.date.timeIntervalSince(s)) } }
        VStack(alignment: .leading, spacing: 12) {
            Picker("Show", selection: $metric) {
                ForEach(Metric.allCases) { Text($0.short).tag($0) }
            }
            .pickerStyle(.segmented)
            readout(points, picked)
            Chart {
                ForEach(points) { p in
                    AreaMark(x: .value("Day", p.date, unit: .day), y: .value(metric.title, metric.value(p.day)))
                        .foregroundStyle(.linearGradient(colors: [accent(redaction).opacity(0.3), accent(redaction).opacity(0)],
                                                         startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Day", p.date, unit: .day), y: .value(metric.title, metric.value(p.day)))
                        .foregroundStyle(accent(redaction))
                        .interpolationMethod(.monotone)
                }
                if let picked {
                    RuleMark(x: .value("Day", picked.date, unit: .day))
                        .foregroundStyle(Color.secondary.opacity(0.5))
                        .lineStyle(StrokeStyle(lineWidth: 1))
                    PointMark(x: .value("Day", picked.date, unit: .day), y: .value(metric.title, metric.value(picked.day)))
                        .foregroundStyle(accent(redaction))
                        .symbolSize(60)
                }
            }
            .chartXSelection(value: $selected)
            .chartXAxis {
                // Fewer dates as the text grows, so they never run into each other.
                AxisMarks(values: .automatic(desiredCount: typeSize.isAccessibilitySize ? 2 : 4)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.day().month(.abbreviated), centered: false)
                }
            }
            .frame(height: 200)
            // The days are UTC midnights; the axis labels them as such.
            .environment(\.timeZone, .gmt)
            .accessibilityChartDescriptor(ActivityDescriptor(points: points.map { ($0.date, metric.value($0.day)) }, title: metric.title))
            .sensoryFeedback(.selection, trigger: picked?.date)
            .animation(.smooth(duration: 0.3), value: metric)
        }
    }

    /// The figure above the chart: the day under the finger, or the period's.
    @ViewBuilder private func readout(_ points: [Point], _ picked: Point?) -> some View {
        let values = points.map { metric.value($0.day) }
        let total = values.reduce(0, +)
        VStack(alignment: .leading, spacing: 2) {
            if let picked {
                Text(metric.value(picked.day).formatted())
                    .font(.title.weight(.semibold).monospacedDigit())
                Text(picked.date.formatted(.dateTime.weekday(.wide).day().month(.wide).utc()))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if metric == .active {
                Text((values.isEmpty ? 0 : total / values.count).formatted())
                    .font(.title.weight(.semibold).monospacedDigit())
                Text("A day on average, at most \((values.max() ?? 0).formatted())")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text(total.formatted())
                    .font(.title.weight(.semibold).monospacedDigit())
                Text(metric == .new && cut != nil ? "In total, counted over the last \(cut!) days" : "In total")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .contentTransition(.numericText())
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// What VoiceOver's audio graph and chart summary read.
struct ActivityDescriptor: AXChartDescriptorRepresentable {
    let points: [(Date, Int)]
    let title: String

    func makeChartDescriptor() -> AXChartDescriptor {
        let format = Date.FormatStyle.dateTime.day().month(.abbreviated).utc()
        let labels = points.map { $0.0.formatted(format) }
        let top = Double(max(points.map(\.1).max() ?? 0, 1))
        let x = AXCategoricalDataAxisDescriptor(title: "Day", categoryOrder: labels)
        let y = AXNumericDataAxisDescriptor(title: title, range: 0...top, gridlinePositions: []) { "\(Int($0))" }
        let series = AXDataSeriesDescriptor(name: title, isContinuous: true,
                                            dataPoints: zip(labels, points).map { AXDataPoint(x: $0, y: Double($1.1)) })
        return AXChartDescriptor(title: "\(title) per day", summary: nil, xAxis: x, yAxis: y, additionalAxes: [], series: [series])
    }
}

/// Of the installs old enough, the share still active one, seven and thirty days on.
struct RetentionRings: View {
    let retention: AppDetail.Retention
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var ring: CGFloat = 68
    @ScaledMetric(relativeTo: .subheadline) private var stroke: CGFloat = 7

    var body: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 16)) : AnyLayout(HStackLayout(spacing: 12))
        layout {
            ForEach([("Day 1", retention.d1), ("Day 7", retention.d7), ("Day 30", retention.d30)], id: \.0) { label, r in
                VStack(spacing: 8) {
                    ZStack {
                        Circle().stroke(.quaternary, lineWidth: stroke)
                        Circle()
                            .trim(from: 0, to: r.rate ?? 0)
                            .stroke(accent(redaction), style: StrokeStyle(lineWidth: stroke, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                        Text(r.rate.map { $0.formatted(.percent.precision(.fractionLength(0))) } ?? "–")
                            .font(.subheadline.weight(.semibold).monospacedDigit())
                    }
                    .frame(width: ring, height: ring)
                    Text(label).font(.subheadline.weight(.medium))
                    Text("\(r.retained.formatted()) of \(r.cohort.formatted())")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label)
                .accessibilityValue(r.rate.map { "\($0.formatted(.percent.precision(.fractionLength(0)))), \(r.retained) of \(r.cohort) installs" } ?? "Not enough installs yet")
            }
        }
    }
}

/// Labelled counts as bars of their share of the largest.
struct Bars: View {
    struct Row: Identifiable {
        let id: String
        var label: String
        let value: Int
        /// A second count, under or beside the first: `12 installs`.
        var detail: String? = nil
        /// A label in the code's own words (an event, a version), set in a monospaced face.
        var code = false
        /// A row standing for "no value", in italics.
        var muted = false
    }

    let rows: [Row]
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var labelWidth: CGFloat = 110

    var body: some View {
        let top = max(rows.map(\.value).max() ?? 1, 1)
        VStack(spacing: typeSize.isAccessibilitySize ? 14 : 10) {
            ForEach(rows) { row in
                Group {
                    if typeSize.isAccessibilitySize {
                        // The label and count on a line, the bar under them: nothing has to be cut.
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                label(row)
                                Spacer()
                                count(row)
                            }
                            bar(row.value, of: top)
                        }
                    } else {
                        HStack(spacing: 10) {
                            label(row).lineLimit(1).frame(width: labelWidth, alignment: .leading)
                            bar(row.value, of: top)
                            count(row).frame(minWidth: 44, alignment: .trailing)
                        }
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.label)
                .accessibilityValue([row.value.formatted(), row.detail].compactMap(\.self).joined(separator: ", "))
            }
        }
    }

    private func label(_ row: Row) -> some View {
        Text(row.label)
            .font(row.code ? .caption.monospaced() : .subheadline)
            .italic(row.muted)
            .foregroundStyle(row.muted ? .secondary : .primary)
    }

    private func bar(_ n: Int, of top: Int) -> some View {
        GeometryReader { g in
            Capsule().fill(accent(redaction).opacity(0.75))
                .frame(width: max(4, g.size.width * CGFloat(n) / CGFloat(top)))
        }
        .frame(height: 8)
    }

    private func count(_ row: Row) -> some View {
        VStack(alignment: .trailing, spacing: 0) {
            Text(row.value, format: .number).font(.caption.weight(.medium).monospacedDigit())
            if let detail = row.detail {
                Text(detail).font(.caption2.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

/// An event counted by one prop's values: per event, or once per install
/// for an answer an install can change later (a variant, a plan).
struct BreakdownBars: View {
    let rows: [BreakdownRow]
    var perInstall = false
    let empty: String
    /// Leaves out the events without the prop (untagged sessions, say).
    var taggedOnly = false

    var body: some View {
        let shown = rows.filter { !taggedOnly || $0.value != "unset" }
        if shown.isEmpty {
            EmptyNote(empty)
        } else {
            Bars(rows: shown.map { r in
                Bars.Row(id: r.value,
                         label: r.value == "unset" ? "none" : r.value.replacingOccurrences(of: "_", with: " "),
                         value: perInstall ? r.installs : r.n,
                         detail: perInstall ? plural(r.n, "event") : plural(r.installs, "install"),
                         muted: r.value == "unset")
            })
        }
    }
}

/// `1 install`, `12 installs`.
func plural(_ n: Int, _ word: String) -> String {
    "\(n.formatted()) \(word)\(n == 1 ? "" : "s")"
}
