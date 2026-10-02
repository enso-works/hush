import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A per-app event catalog the way an operator supplies one (CATALOG_FILE):
// here, Braele's real one, so the suite exercises the configuration the
// first production deployment runs. Servers that predate CATALOG_FILE had
// exactly this list built in, which is what the baseline run relies on.
export const CATALOG = {
  braele: {
    events: [
      'app_first_opened', 'session_started', 'screen_viewed', 'onboarding_completed', 'intent_selected',
      'breathing_session_started', 'breathing_session_completed', 'paywall_viewed', 'purchase_started',
      'purchase_result', 'restore_result', 'reminder_set', 'feature_used', 'ticket_opened',
    ],
    highlight: { event: 'breathing_session_completed', done_prop: 'completed' },
    // Braele 2.0.0 and 2.0.1 name a screen by its URL: support/<ticket id>.
    private_screens: ['support'],
    // Remote config (SDK 2.4.0), for the /v1/config steps of the compat script.
    config: {
      new_home: { type: 'bool', default: false, description: 'The redesigned home screen.',
        rules: [{ when: { platform: ['ios'], version: '>=2.1.0' }, rollout: 20, value: true }] },
      session_presets: { type: 'json', default: [3, 5, 10], description: 'Session lengths on the start screen, in minutes.' },
    },
  },
};

// One file per test process: every process that imports this writes it, and
// a run in another checkout (with another catalog) would otherwise land
// between this one's write and its server's boot.
export const CATALOG_FILE = join(tmpdir(), `hush-test-catalog-${process.pid}.json`);
writeFileSync(CATALOG_FILE, JSON.stringify(CATALOG));
process.on('exit', () => rmSync(CATALOG_FILE, { force: true }));
