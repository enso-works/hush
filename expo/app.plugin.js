// Config plugin: where iOS sends copies of the ad attribution postbacks.
//
//   ["@bavrk/hush-expo", { "attributionEndpoint": "https://example.com" }]
//
// iOS keeps only the registrable domain (example.com) and posts to
// /.well-known/skadnetwork/report-attribution/ and
// /.well-known/appattribution/report-attribution/ there, which the proxy in
// front of hush forwards to it.
/** The Info.plist keys, on a plain object: what the plugin writes, testable without Expo. */
function applyEndpoint(plist, endpoint) {
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(endpoint)) throw new Error('@bavrk/hush-expo: attributionEndpoint is https://<domain>, nothing after it');
  plist.NSAdvertisingAttributionReportEndpoint = endpoint;
  plist.AdAttributionKit = { ...(plist.AdAttributionKit ?? {}), AttributionCopyEndpoint: endpoint };
  return plist;
}

function withHushExpo(config, options = {}) {
  if (!options.attributionEndpoint) return config;
  const endpoint = options.attributionEndpoint;
  applyEndpoint({}, endpoint); // fail at prebuild, not in a build that never gets a postback
  const { withInfoPlist } = require('expo/config-plugins');
  return withInfoPlist(config, (c) => {
    applyEndpoint(c.modResults, endpoint);
    return c;
  });
}

module.exports = withHushExpo;
module.exports.applyEndpoint = applyEndpoint;
