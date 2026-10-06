import CoreImage.CIFilterBuiltins
import HushKit
import SwiftUI

/// The phones signed in to a server with a token of their own: this one
/// marked, each revocable, and a code to sign in another.
struct PhonesView: View {
    let server: Server

    @Environment(AppModel.self) private var model
    @State private var devices: [Device]?
    @State private var error: HushError?
    @State private var revoking: Device?
    @State private var problem: HushError?
    @State private var pairing: Pairing?
    @State private var making = false
    @State private var revoked = 0

    var body: some View {
        List {
            if let error { ErrorNote(error: error) { await load() }.listRowBackground(Color.clear) }
            if !server.isDemo {
                Section {
                    if let pairing {
                        PairingCode(link: PairingLink(server: server.baseURL, code: pairing.code), expires: pairing.expiresAt)
                    } else {
                        Button {
                            Task { await makePairing() }
                        } label: {
                            HStack {
                                Label("Sign In Another Phone", systemImage: "qrcode")
                                if making { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(making)
                    }
                } footer: {
                    Text("A QR code for another phone's camera, as the dashboard's Phones page shows: it works once, for ten minutes.")
                }
            }
            if let devices {
                Section {
                    if devices.isEmpty {
                        Text("No phone signs in with a token of its own.").foregroundStyle(.secondary)
                    }
                    ForEach(devices) { d in
                        DeviceRow(device: d, isThis: d.id == server.deviceID)
                            .swipeActions {
                                if d.id != server.deviceID, !server.isDemo {
                                    Button("Revoke", role: .destructive) { revoking = d }
                                }
                            }
                    }
                } footer: {
                    Text("Revoking signs a phone out at once. This phone signs itself out when you remove the server in Settings.")
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Phones")
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("Revoke \(revoking?.name ?? "")?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
                            titleVisibility: .visible, presenting: revoking) { d in
            Button("Revoke", role: .destructive) { Task { await revoke(d) } }
        } message: { _ in
            Text("It is signed out at once and needs a new code to sign in again.")
        }
        .alert("Could not do that", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } }), presenting: problem) { _ in
            Button("OK", role: .cancel) {}
        } message: { Text($0.message) }
        .sensoryFeedback(.success, trigger: revoked)
        .onAppear { Telemetry.screen("phones") }
    }

    private func load() async {
        do {
            let fresh = try await model.client(for: server).devices()
            withAnimation { devices = fresh.sorted { ($0.id == server.deviceID ? 0 : 1, $1.createdAt) < ($1.id == server.deviceID ? 0 : 1, $0.createdAt) } }
            error = nil
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { self.error = HushError(error) }
        }
    }

    private func revoke(_ d: Device) async {
        do {
            try await model.client(for: server).revokeDevice(d.id)
            withAnimation { devices?.removeAll { $0.id == d.id } }
            revoked += 1
            Telemetry.track("phone_revoked")
        } catch {
            problem = HushError(error)
        }
    }

    private func makePairing() async {
        making = true
        defer { making = false }
        do {
            let p = try await model.client(for: server).createPairing()
            withAnimation { pairing = p }
            Telemetry.track("pairing_created")
        } catch {
            problem = HushError(error)
        }
    }
}

private struct DeviceRow: View {
    let device: Device
    let isThis: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "iphone")
                .font(.title3)
                .foregroundStyle(isThis ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(device.name)
                    if isThis { Badge(text: "This phone", tint: .accentColor) }
                }
                Text("Signed in \(device.createdAt.formatted(date: .abbreviated, time: .omitted)), last seen \(when(device.lastSeenAt))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The link as a QR code, with the time it has left.
private struct PairingCode: View {
    let link: PairingLink
    let expires: Date

    var body: some View {
        VStack(spacing: 12) {
            if let image = qr(link.url.absoluteString) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 220)
                    .padding(12)
                    .background(.white, in: .rect(cornerRadius: 12))
                    .accessibilityLabel("QR code for signing in another phone")
            }
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = expires.timeIntervalSince(context.date)
                Text(left > 0 ? "Works for \(Duration.seconds(left).formatted(.time(pattern: .minuteSecond)))" : "Expired: make a new one")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(left > 0 ? AnyShapeStyle(.secondary) : AnyShapeStyle(.red))
            }
            ShareLink(item: link.url) { Label("Share Link", systemImage: "square.and.arrow.up") }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private func qr(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
