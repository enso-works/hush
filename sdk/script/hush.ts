/**
 * hush for a site without a bundler: one script tag, served by the hush
 * server at /hush.js (built into ../src/script/hush.js by `npm run
 * build:script`, committed like the dashboard).
 *
 *   <script defer src="https://hush.example.com/hush.js" data-key="hush_mysite_prod_…"></script>
 *
 * It tracks pages, the visit's entry and store and outbound links by itself
 * (createWebHush's autoTrack), and leaves the client on window.hush for the
 * page's own events: hush.track('signup_started').
 *
 * data-key      the write key (required)
 * data-url      the hush server; default: where this script came from
 * data-channel  the channel, e.g. landing
 * data-version  the site's version
 * data-provider-token  App Store Connect's provider token (pt), for store links
 * data-auto-track      "false": nothing by itself, the page calls hush.screen()
 */
import { createWebHush } from '../src/web.ts';

declare global {
  interface Window {
    hush?: ReturnType<typeof createWebHush>;
  }
}

const el = (document.currentScript ?? document.querySelector('script[data-key][src*="hush.js"]')) as HTMLScriptElement | null;
const data = el?.dataset ?? {};
let origin = '';
try {
  origin = el?.src ? new URL(el.src).origin : '';
} catch {
  // An odd src: data-url has to say where the server is.
}

const hush = createWebHush({
  platform: 'web',
  version: data.version,
  autoTrack: data.autoTrack !== 'false',
  appStore: data.providerToken ? { providerToken: data.providerToken } : undefined,
});
hush.configure({
  url: data.url || origin,
  key: data.key ?? '',
  channel: data.channel || undefined,
  // A site reads no remote config; an app on the same origin keeps its own.
  remoteConfig: false,
});
void hush.init();
window.hush = hush;
