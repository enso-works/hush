import SwiftUI

/// An app's initial on its colour: the same hue for the same slug as on the
/// web dashboard (`oklch(0.62 0.16 h)`, h from the slug).
struct AppMark: View {
    let slug: String
    let name: String
    var size: CGFloat = 36

    var body: some View {
        Text(name.prefix(1).uppercased())
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Self.color(for: slug), in: .rect(cornerRadius: size * 0.28))
            .accessibilityHidden(true)
    }

    static func color(for slug: String) -> Color {
        var h = 0
        for c in slug.utf16 { h = (h * 31 + Int(c)) % 360 }
        return oklch(l: 0.62, c: 0.16, h: Double(h))
    }

    /// OKLCH to sRGB (Björn Ottosson's OKLab matrices), clamped to the gamut.
    static func oklch(l: Double, c: Double, h: Double) -> Color {
        let a = c * cos(h * .pi / 180), b = c * sin(h * .pi / 180)
        let l3 = pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
        let m3 = pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
        let s3 = pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
        let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
        let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
        let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
        func encode(_ x: Double) -> Double {
            let v = min(max(x, 0), 1)
            return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055
        }
        return Color(.sRGB, red: encode(r), green: encode(g), blue: encode(bl))
    }
}
