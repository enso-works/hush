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
 *
 * A website (rather than a web app) passes autoTrack: every page is a
 * screen, the visit keeps the link and the referring site it came from, and
 * clicks on store links and outbound links are events. A page load within
 * half an hour of the last one carries on its session, so a visit of five
 * pages is one session.
 */
import { createHush, type DeviceInfo, type HushStorage } from './core.ts';

export type WebApp = {
  /** The app's version, e.g. from package.json through the bundler. */
  version?: string;
  /** The build number, if the app has one. */
  build?: string;
  /**
   * Overrides the platform read from the user agent: "ios" for a Capacitor
   * build, say. Remote config's platform rules read it too, so a browser build
   * that shares an app with the native one passes "web": otherwise an iPhone
   * browser is "ios" and matches rules meant for the native app.
   */
  platform?: string;
  /** A development build: events default to the "dev" channel. */
  dev?: boolean;
  /** For a website: what the SDK tracks by itself. true is all of it. Default: none. */
  autoTrack?: boolean | WebAutoTrack;
  /**
   * The App Store Connect provider token (`pt` in a campaign link). With it,
   * App Store links clicked on the page, and storeLink(), carry it and the
   * visit's campaign as `ct`: App Store Connect's campaign report counts
   * page views and installs for the campaign the site saw.
   */
  appStore?: { providerToken: string };
};

export type WebAutoTrack = {
  /** screen(path) for every page, the path without its query or hash, on load and on client-side navigation. */
  pageviews?: boolean;
  /** The visit's first session keeps its link's utm_* and ref tags, and the referring site's host. */
  entry?: boolean;
  /** store_clicked { store, campaign } for App Store, Google Play and TestFlight links; link_clicked { host } for links off the site. */
  links?: boolean;
};

const STORES: Record<string, string> = {
  'apps.apple.com': 'app_store',
  'itunes.apple.com': 'app_store',
  'testflight.apple.com': 'testflight',
  'play.google.com': 'play',
};

// The visit's campaign, for store links on later pages. Per tab, gone with it.
const CAMPAIGN_KEY = 'hush.campaign.v1';

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** sessionStorage, or null where it is missing or refused. */
function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * A campaign as App Store Connect takes it in `ct`: up to 40 characters, and
 * nothing a URL would need to escape, so the report shows what the site saw.
 */
export function campaignToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
}

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
  const auto: WebAutoTrack = app.autoTrack === true ? { pageviews: true, entry: true, links: true } : app.autoTrack || {};
  const providerToken = typeof app.appStore?.providerToken === 'string' ? app.appStore.providerToken.trim() : '';
  // A page being unloaded: Chromium drops a keepalive fetch that needs a CORS
  // preflight (hush's Authorization header does, on another origin), so what
  // was tracked on the last page would wait for a next visit. A beacon goes.
  let leaving = false;
  if (typeof addEventListener === 'function') {
    // Before the SDK's own pagehide listener, so its send sees the flag.
    addEventListener('pagehide', () => (leaving = true));
    // Back from the back-forward cache: the page lives again.
    addEventListener('pageshow', () => (leaving = false));
  }
  const send: typeof fetch = (input, init) => {
    const beacon = typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
    // Hidden too: browsers differ on whether visibilitychange or pagehide
    // comes first as a page goes, and the first send is the one that counts.
    const hidden = leaving || (typeof document !== 'undefined' && document.visibilityState === 'hidden');
    if (hidden && beacon && init?.method === 'POST' && String(input).endsWith('/v1/events')) {
      const auth = String((init.headers as Record<string, string> | undefined)?.Authorization ?? '');
      const key = auth.replace(/^Key\s+/, '');
      // text/plain: a beacon with any other type is preflighted too.
      navigator.sendBeacon(`${String(input)}?key=${encodeURIComponent(key)}`, new Blob([String(init.body ?? '')], { type: 'text/plain' }));
      // Its answer is never seen, so the events stay queued: the next page
      // sends them again and the server counts them as duplicates. A server
      // without beacons refuses this one, and loses nothing.
      return Promise.reject(new Error('sent as a beacon'));
    }
    // keepalive: a batch sent as the page hides still arrives after it is gone
    // (bodies up to 64 KB, far more than a batch).
    return fetch(input, { ...init, keepalive: true });
  };
  const hush = createHush({
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
    fetch: send,
    resumeSessions: true,
  });

  /** The visit's campaign: its link's utm_campaign or utm_source, or the site that sent it. '' when it came straight. */
  function campaign(): string {
    try {
      return tabStorage()?.getItem(CAMPAIGN_KEY) ?? '';
    } catch {
      return '';
    }
  }

  /**
   * An App Store link with the provider token and the visit's campaign
   * (`pt`, `ct`), for a link the page builds itself. Any other link, and an
   * App Store link without appStore.providerToken, comes back as it was.
   * What the link already says wins.
   */
  function storeLink(url: string): string {
    if (!providerToken) return url;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return url;
    }
    if (STORES[u.hostname] !== 'app_store') return url;
    if (!u.searchParams.has('pt')) u.searchParams.set('pt', providerToken);
    const ct = campaign();
    if (ct && !u.searchParams.has('ct')) u.searchParams.set('ct', ct);
    return u.toString();
  }

  // Where the visit came from, before init() so the first session takes it.
  function claimEntry() {
    if (typeof location === 'undefined') return;
    const tagged = /[?&](utm_[a-z]+|ref)=/i.test(location.search);
    let referrer = '';
    try {
      const from = typeof document !== 'undefined' && document.referrer ? new URL(document.referrer) : null;
      if (from && /^https?:$/.test(from.protocol) && stripWww(from.hostname) !== stripWww(location.hostname)) referrer = stripWww(from.hostname);
    } catch {
      // Not a URL: no referrer.
    }
    if (tagged) hush.entry('link', { url: location.href, referrer });
    else if (referrer) hush.entry('referral', { referrer });
    // A landing (a link, or another site) names the visit's campaign; a page
    // reached from within the site keeps the one it has.
    const params = new URLSearchParams(location.search);
    const name = params.get('utm_campaign') || params.get('utm_source') || referrer;
    if (name) {
      try {
        tabStorage()?.setItem(CAMPAIGN_KEY, campaignToken(name));
      } catch {
        // Refused: store links go without a campaign.
      }
    }
  }

  function trackPages() {
    if (typeof location === 'undefined') return;
    let last = '';
    const view = () => {
      const path = location.pathname.slice(0, 128) || '/';
      if (path === last) return;
      last = path;
      hush.screen(path);
    };
    view();
    // Client-side navigation: pushState is a new page, popstate is back and
    // forward. replaceState is left alone, as apps use it for the query.
    if (typeof history !== 'undefined' && typeof history.pushState === 'function') {
      const push = history.pushState.bind(history);
      history.pushState = (...args: Parameters<History['pushState']>) => {
        push(...args);
        view();
      };
    }
    if (typeof addEventListener === 'function') addEventListener('popstate', view);
  }

  function trackLinks() {
    if (typeof document === 'undefined' || typeof location === 'undefined') return;
    const onClick = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      let u: URL;
      try {
        u = new URL(a.href, location.href);
      } catch {
        return;
      }
      if (!/^https?:$/.test(u.protocol) || u.host === location.host) return;
      const store = STORES[u.hostname];
      if (store) {
        // Before the browser follows it: the click goes to the link as rewritten.
        if (store === 'app_store') {
          const tagged = storeLink(a.href);
          if (tagged !== a.href) a.href = tagged;
        }
        hush.track('store_clicked', { store, campaign: campaign() || null });
      } else {
        hush.track('link_clicked', { host: stripWww(u.hostname) });
      }
    };
    // Capture, so a handler that stops the event does not hide the click; a
    // middle click opens a tab without a click event.
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
  }

  let started = false;
  let waiting: Promise<void> | null = null;
  /**
   * init(), and on the first call the automatic tracking. A browser driven
   * by automation (navigator.webdriver: a test run, a scraper) sends
   * nothing. A prerendered page starts when it is shown, if it ever is.
   */
  function init(): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.webdriver) return Promise.resolve();
    const doc = typeof document === 'undefined' ? null : (document as Document & { prerendering?: boolean });
    if (doc?.prerendering) {
      waiting ??= new Promise((resolve) => doc.addEventListener('prerenderingchange', () => resolve(init()), { once: true }));
      return waiting;
    }
    if (!started) {
      started = true;
      if (auto.entry) claimEntry();
      if (auto.pageviews) trackPages();
      if (auto.links) trackLinks();
    }
    return hush.init();
  }

  return { ...hush, init, storeLink };
}

export { SDK_VERSION } from './core.ts';
export type {
  AttributionBridge,
  ConfigRefreshResult,
  ConfigSnapshotEntry,
  ConfigType,
  ConversionValue,
  DeviceInfo,
  Entry,
  FlushResult,
  Hush,
  HushConfig,
  HushRemoteConfig,
  Props,
  RemoteConfigOptions,
  Ticket,
  TicketKind,
} from './core.ts';
