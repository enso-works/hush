import HushKit
import SwiftUI

/// First launch: no server yet.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @State private var adding = false
    @State private var scanning = false
    @State private var scanned: PairingLink?

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            // The hush mark, as on the dashboard, the site and the app icon.
            Image("Logo")
                .resizable()
                .frame(width: 88, height: 88)
                .accessibilityHidden(true)
            VStack(spacing: 8) {
                Text("hush").font(.largeTitle.bold())
                Text("Read and answer your users' feedback, and see how your apps are used, from your own hush server.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(spacing: 12) {
                Button {
                    scanning = true
                } label: {
                    Label("Scan the dashboard's QR code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button {
                    adding = true
                } label: {
                    Text("Add your server").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button {
                    model.addDemo()
                    Telemetry.track("server_added", ["method": "demo"])
                } label: {
                    Text("Try the demo").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Text("The demo shows invented apps and is read-only.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .controlSize(.large)
        }
        .padding(24)
        .onAppear { Telemetry.screen("welcome") }
        .sheet(isPresented: $adding) {
            NavigationStack { ServerForm(editing: nil) }
        }
        // The pairing sheet opens once the scanner has gone, not over it.
        .sheet(isPresented: $scanning, onDismiss: {
            if let scanned { model.pairing = scanned }
            scanned = nil
        }) {
            ScannerSheet { link in
                scanned = link
                scanning = false
            }
        }
    }
}
