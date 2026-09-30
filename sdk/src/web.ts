/**
 * hush for the web, and for web apps wrapped as native ones (Capacitor, a
 * WebView): the same core as the React Native entry, given localStorage, the
 * page's visibility as the app lifecycle, and the user agent as the device.
 *
 *   import { createWebHush } from '@bavrk/hush/web';
 *   export const hush = createWebHush({ version: '1.2.0', build: '42' });
 *   hush.configure({ url, key });
 *   hush.init();
 *
 * A web page has no version of its own, so the app says which one it is.
 * The server must answer CORS for the page's origin; hush's /v1 does.
 */
import { createHush, type DeviceInfo, type HushStorage } from './core.ts';

export type WebApp = {
  /** The app's version, e.g. from package.json through the bundler. */
  version?: string;
  /** The build number, if the app has one. */
  build?: string;
  /** Overrides the platform read from the user agent: "ios" for a Capacitor build, say. */
  platform?: string;
  /** A development build: events default to the "dev" channel. */
  dev?: boolean;
};

/** localStorage, or memory where it is missing or refused (private mode, a sandboxed frame). */
function webStorage(): HushStorage {
  const memory = new Map<string, string>();
  const ls = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    async getItem(k) {
      try {
        return ls()?.getItem(k) ?? memory.get(k) ?? null;
      } catch {
        return memory.get(k) ?? null;
      }
    },
    async setItem(k, v) {
      memory.set(k, v);
      try {
        ls()?.setItem(k, v);
      } catch {
        // Full or refused: memory keeps it for this page's life.
      }
    },
    async removeItem(k) {
      memory.delete(k);
      try {
        ls()?.removeItem(k);
      } catch {
        // Nothing to do.
      }
    },
  };
}

/**
 * Platform, OS and device from the user agent, coarsely: "ios 18.2" and
 * "iPhone", "macOS 15.1" and "Mac". Never the whole string, which is close
 * to a fingerprint.
 */
export function fromUserAgent(ua: string): Pick<DeviceInfo, 'platform' | 'os' | 'device'> {
  const v = (s: string | undefined) => (s ?? '').replace(/_/g, '.');
  let m: RegExpExecArray | null;
  if ((m = /\b(iPhone|iPad|iPod)\b.*? OS (\d+[_.]\d+(?:[_.]\d+)?)/.exec(ua))) return { platform: 'ios', os: `ios ${v(m[2])}`, device: m[1] };
  if ((m = /Android (\d+(?:\.\d+)*)/.exec(ua))) return { platform: 'android', os: `android ${m[1]}`, device: /Mobile/.test(ua) ? 'Android phone' : 'Android tablet' };
  // iPadOS asks for the desktop site and says Macintosh; touch gives it away.
  if ((m = /Mac OS X (\d+[_.]\d+(?:[_.]\d+)?)/.exec(ua))) {
    const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 1;
    return touch ? { platform: 'ios', os: 'ios', device: 'iPad' } : { platform: 'web', os: `macOS ${v(m[1])}`, device: 'Mac' };
  }
  if ((m = /Windows NT (\d+\.\d+)/.exec(ua))) return { platform: 'web', os: `windows ${m[1]}`, device: 'PC' };
  if (/CrOS/.test(ua)) return { platform: 'web', os: 'chromeos', device: 'Chromebook' };
  if (/Linux/.test(ua)) return { platform: 'web', os: 'linux', device: 'PC' };
  return { platform: 'web', os: '', device: '' };
}

/** A hush client for this page. One per page: it owns the page's lifecycle listeners. */
export function createWebHush(app: WebApp = {}) {
  return createHush({
    storage: webStorage(),
    onAppState(listener) {
      if (typeof document === 'undefined') return;
      document.addEventListener('visibilitychange', () => listener(document.visibilityState === 'visible' ? 'active' : 'background'));
      // Closing the tab or the app may skip visibilitychange; pagehide is the last word.
      if (typeof addEventListener === 'function') addEventListener('pagehide', () => listener('background'));
    },
    device: () => {
      const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
      const found = fromUserAgent(ua);
      return {
        version: app.version ?? '',
        build: app.build ?? '',
        platform: app.platform ?? found.platform,
        os: found.os,
        device: found.device,
        locale: typeof navigator === 'undefined' ? '' : (navigator.languages?.[0] ?? navigator.language ?? ''),
      };
    },
    isDev: () => !!app.dev,
    // keepalive: a batch sent as the page hides still arrives after it is gone
    // (bodies up to 64 KB, far more than a batch).
    fetch: (input, init) => fetch(input, { ...init, keepalive: true }),
  });
}

export { SDK_VERSION } from './core.ts';
export type { DeviceInfo, Entry, FlushResult, Hush, HushConfig, Props, Ticket, TicketKind } from './core.ts';
