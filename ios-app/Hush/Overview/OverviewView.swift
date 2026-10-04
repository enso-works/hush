import HushKit
import SwiftUI

/// Every app on one server, as the dashboard's overview shows them.
struct OverviewView: View {
    let server: Server
    @Environment(AppModel.self) private var model
    @State private var apps: [AppSummary] = []
    @State private var error: HushError?
    @State private var loading = true

    var body: some View {
        List {
            if let error {
                Section { ErrorRow(error: error) }
            }
            ForEach(apps) { app in
                AppRow(app: app)
            }
        }
        .overlay {
            if loading && apps.isEmpty { ProgressView() }
            else if !loading && apps.isEmpty && error == nil {
                ContentUnavailableView("No apps yet", systemImage: "square.grid.2x2", description: Text("Register one on the server with `apps:add`."))
            }
        }
        .navigationTitle(server.name)
        .task(id: server) {
            apps = []
            await load()
        }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            apps = try await model.client(for: server).apps().apps
            error = nil
        } catch let e as HushError {
            error = e
        } catch {
            self.error = .unreachable(error.localizedDescription)
        }
    }
}

private struct AppRow: View {
    let app: AppSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(app.name).font(.headline)
                Spacer()
                if app.openTickets > 0 {
                    Label("\(app.openTickets)", systemImage: "bubble.left")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tint)
                }
            }
            HStack(spacing: 16) {
                Metric(label: "DAU", value: app.dau)
                Metric(label: "WAU", value: app.wau)
                Metric(label: "MAU", value: app.mau)
                Metric(label: "New", value: app.newInstalls)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct Metric: View {
    let label: String
    let value: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value, format: .number).font(.subheadline.monospacedDigit())
        }
    }
}

struct ErrorRow: View {
    let error: HushError

    var body: some View {
        Label(error.message, systemImage: "exclamationmark.triangle")
            .foregroundStyle(.red)
    }
}

extension HushError {
    /// What the app says about it.
    var message: String {
        switch self {
        case .unauthorized: "The server refused the token."
        case .readOnly: "The demo is read-only."
        case .notFound: "Not found: it may have been deleted."
        case .server(let status, let message): "The server answered \(status): \(message)"
        case .unreachable(let reason): "Could not reach the server. \(reason)"
        case .unreadable: "The answer was not what a hush server sends. Is this the right address?"
        }
    }
}
