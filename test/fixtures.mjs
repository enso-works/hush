import { writeFileSync } from 'node:fs';
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
  },
};

export const CATALOG_FILE = join(tmpdir(), 'hush-test-catalog.json');
writeFileSync(CATALOG_FILE, JSON.stringify(CATALOG));
