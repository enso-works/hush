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

struct ErrorNote: View {
    let error: HushError

    var body: some View {
        Label(error.message, systemImage: "exclamationmark.triangle")
            .font(.callout)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(.red.opacity(0.08), in: .rect(cornerRadius: 14))
    }
}
