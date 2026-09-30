// Config plugin: where iOS sends copies of the ad attribution postbacks.
//
//   ["@bavrk/hush-expo", { "attributionEndpoint": "https://example.com" }]
//
// iOS keeps only the registrable domain (example.com) and posts to
// /.well-known/skadnetwork/report-attribution/ and
// /.well-known/appattribution/report-attribution/ there, which the proxy in
// front of hush forwards to it.
const { withInfoPlist } = require('expo/config-plugins');

module.exports = function withHushExpo(config, options = {}) {
  const endpoint = options.attributionEndpoint;
  if (!endpoint) return config;
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(endpoint)) throw new Error('@bavrk/hush-expo: attributionEndpoint is https://<domain>, nothing after it');
  return withInfoPlist(config, (c) => {
    c.modResults.NSAdvertisingAttributionReportEndpoint = endpoint;
    c.modResults.AdAttributionKit = { ...(c.modResults.AdAttributionKit ?? {}), AttributionCopyEndpoint: endpoint };
    return c;
  });
};
