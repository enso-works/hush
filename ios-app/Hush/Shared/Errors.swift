import HushKit
import SwiftUI

extension HushError {
    /// What the app says about it.
    var message: String {
        switch self {
        case .unauthorized: "The server refused the token. Edit the server to give it again."
        case .readOnly: "The demo is read-only."
        case .notFound: "Not found: it may have been deleted."
        case .server(let status, let message): "The server answered \(status): \(message)"
        case .unreachable(let reason): "Could not reach the server. \(reason)"
        case .unreadable: "The answer was not what a hush server sends. Is this the right address?"
        }
    }

    init(_ error: any Error) {
        self = error as? HushError ?? .unreachable(error.localizedDescription)
    }
}

/// What went wrong, and a way to try again without knowing about pull to refresh.
struct ErrorNote: View {
    let error: HushError
    var retry: (() async -> Void)? = nil
    @State private var retrying = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(error.message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.red)
            if let retry {
                Button {
                    Task {
                        retrying = true
                        await retry()
                        retrying = false
                    }
                } label: {
                    if retrying {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Try again")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(retrying)
            }
        }
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.red.opacity(0.08), in: .rect(cornerRadius: 14))
    }
}
