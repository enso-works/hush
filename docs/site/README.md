# The site's content

What [hush.bavrk.com](https://hush.bavrk.com) says. It lives here so that a
change to hush and what the site says about it go in one pull request.

| File | On the site |
|---|---|
| `docs.md` | [/docs](https://hush.bavrk.com/docs): run it, wire the SDK, configure it, remote config, the API |
| `en.json` | every string on the landing, legal and support pages |
| `site.config.json` | the feature icons, the showcase screens, the links |
| `shots/` | the showcase's browser frames and the hero's screen, 1200x700, light and dark |

The site's code is in the private `enso-works/bavrk` repository, under
`hush/`. Its build copies these files in (`npm run sync` there), from
`HUSH_DIR`, from `../../hush` beside it, or from this repository's `main`.

- **Shots**: `npm run shots` in `dashboard/` takes them from the live demo,
  with the README's images in `docs/img/`.
- **Strings**: a missing key fails the site's build, naming it. Each
  `features.fN_h` needs an icon in `featureIcons`, and each showcase screen a
  `showcase.sN_h` and `sN_p` (`test/site.test.mjs` checks both).
- **Deploy**: a push to `main` that changes this folder asks bavrk to deploy
  the site (`.github/workflows/site.yml`), when the `BAVRK_DISPATCH_TOKEN`
  secret is set. Otherwise run bavrk's `Deploy hush landing` workflow by hand.
- **Preview**: in a bavrk checkout beside this one, `cd hush && npm run dev`
  syncs from `../../hush` and serves the site on `localhost:4321`.
