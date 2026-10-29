# store/

Store assets for this app, managed with the workspace store tool
(`../../bavrk-apps/tools/store-shots`, plan: `../../bavrk-apps/tools/store-shots/docs/store-tool-plan.md`).

- `manifest.json` — screens, order, template, raw-capture mapping.
- `content/<locale>.json` — screenshot copy per App Store locale.
- `raw/<device>/<locale>/<order>-<id>.png` — raw simulator captures (never written by the generator).
- `assets/fonts|logos|backgrounds` — brand assets; fonts come from `store-shots fonts add <family>`.
- `generated/` — contact sheets and reports (gitignored).

Generated screenshots go to `fastlane/screenshots/<locale>/`; metadata lives in
`fastlane/metadata/<locale>/`. Both are what `fastlane ios screenshots` / `metadata` upload.

```sh
npx --prefix ../../bavrk-apps/tools/store-shots store-shots validate  --project .
npx --prefix ../../bavrk-apps/tools/store-shots store-shots readiness --project .
```
