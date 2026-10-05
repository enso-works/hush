import HushKit
import SwiftUI
import VisionKit

/// The camera, looking for the dashboard's QR code. Where there is no camera
/// (the Simulator, a Mac) or it is not allowed, the link can be pasted instead.
struct ScannerSheet: View {
    let found: (PairingLink) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var pasted = ""
    @State private var problem: String?

    private var canScan: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if canScan {
                    QRScanner { text in
                        if let link = PairingLink(text) { found(link) } else { problem = "That code is not from a hush dashboard." }
                    }
                    .clipShape(.rect(cornerRadius: 20))
                    .overlay(alignment: .bottom) {
                        Text(problem ?? "Point at the QR code on your dashboard's Phones page.")
                            .font(.callout.weight(.medium))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(.regularMaterial, in: .capsule)
                            .padding(16)
                    }
                } else {
                    ContentUnavailableView("No camera here", systemImage: "camera",
                                           description: Text("Paste the link instead: open the dashboard's Phones page, and copy the QR code's link."))
                }
                HStack {
                    TextField("hush://pair?url=…", text: $pasted)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                    Button("Use") {
                        if let link = PairingLink(pasted) { found(link) } else { problem = "That is not a hush pairing link." }
                    }
                    .disabled(pasted.isEmpty)
                }
                if let problem, !canScan {
                    Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.callout)
                }
            }
            .padding(16)
            .navigationTitle("Scan QR code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .sensoryFeedback(trigger: problem) { _, new in new == nil ? nil : .error }
        }
    }
}

/// VisionKit's scanner, for QR codes only, reporting each payload it reads.
private struct QRScanner: UIViewControllerRepresentable {
    let read: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(read: read) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let read: (String) -> Void
        init(read: @escaping (String) -> Void) { self.read = read }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                if let text = code.payloadStringValue { read(text) }
            }
        }
    }
}
