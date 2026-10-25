# OpenCodex provider SVG design system

All new provider marks share a 24 x 24 root canvas with a centered 22 x 22
optical area (1 px transparent safety margin on every side). The original
aspect ratio is maintained using xMidYMid meet. No external resources,
raster images, scripts, fonts, or animation are allowed.

## Reusable template and deterministic reproduction

TEMPLATE.svg is the editable reference. Build and validate via the manifest:

    node gui/scripts/build-provider-icons.mjs --verify   # offline / read-only
    node gui/scripts/build-provider-icons.mjs --write    # rebuild pinned upstream sources

The generator pins immutable source revisions to keep all assets consistent.

- Lobe Icons: https://github.com/lobehub/lobe-icons
  commit e371fcc0b6d5498b189a3fb935f0eb8ca4c33b74 (MIT)
- Simple Icons: https://github.com/simple-icons/simple-icons
  commit 90646e4bf7f3b89df6c37e65baf3e7bc759a517c (CC0 repository)
- Original OpenCodex symbols, NOT official vendor logos: entrim, upstage,
  tokenrouter, unlooseai, parallel, lm7.

Branded color marks retain their colors. Monochrome marks are rendered
through theme-aware CSS masks with var(--text), including legacy OpenAI,
Groq and Grok artwork, to remain legible in dark mode.

Open /provider-icons/gallery.html on the dashboard server for a side-by-side
light/dark inspection of every provider from the reference screenshot.

When adding a provider: add a source entry to the generator manifest or
create an original SVG path in its original-symbol registry; add its ID and
aliases to gui/src/provider-icons.ts; update the provider icon tests. Avoid
hotlinked SVGs or SVG HTML injected from provider responses.

Trademarks remain the property of their owners, and no affiliation or
endorsement is claimed. See ../third-party-notices.txt for attributions.
