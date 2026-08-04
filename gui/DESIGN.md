# gui/DESIGN.md — de ontwerptaal van het dashboard

> De levende ontwerp- en smaakgids voor het opencodex-dashboard (`gui/`).
> Dit is de ChefGroep-taal (v2 "Devin-richting"): een stil, warm, mat instrument.
> Bron van waarheid voor de *taal*: [`GroepOnline/design-system`](https://github.com/GroepOnline/design-system)
> (`tokens.css`, `DESIGN.md`, `motion-spec.md`). Dit bestand legt vast hoe die
> taal in dít dashboard leeft, en — belangrijker — **hoe je 'm uitbreidt zonder
> 'm te breken**.

Alles hier is gebouwd op tokens in `src/styles.css`. Verzin nooit losse
px-waarden of kleuren in een component; gebruik een token. Zo blijft de hele
app in één keer te herstemmen.

---

## 1. De drie pijlers

1. **Stil oppervlak.** Warm off-white, haarlijnen, plat. Geen glow, geen
   gradients, geen glasmorfisme, geen geneste schaduw.
2. **Levende activiteit.** Werk toon je als rust of een golfje, nooit als
   ronddraaiende spinner.
3. **Begrijpelijk.** Eén accent, één type-ladder, één set radii, één easing.
   Hiërarchie komt uit grootte/gewicht/kleur — niet uit decoratie.

---

## 2. Kleur

Eén accent: blauw (`--accent-blue`). Alles wat "klik mij / hier ben je / dit is
aan" zegt is blauw: links, focus-ring, actieve nav, geselecteerde tab, toggles,
selectie. De **primaire knop** blijft juist monochroom (tekst↔achtergrond
omgekeerd) — dat is de shadcn-conventie, geen tweede accent.

| Rol | Token |
|---|---|
| Achtergrond / rail / kaart | `--bg` · `--rail` · `--surface` · `--raised` |
| Lijnen | `--border` (sterk) · `--border-soft` (hairline) |
| Tekst | `--text` · `--muted` · `--faint` |
| Primaire actie | `--accent` (+ `--accent-ink`) |
| Het accent | `--accent-blue` · `--accent-blue-ink` · `--accent-soft` (ring/tint) |
| Semantiek | `--green` (git/PR/toestemming) · `--amber` (wacht-op-jou) · `--red` (destructief) |

Regels: groen/amber/rood zijn **gereserveerd**, nooit decoratie. Neutraal is
warm, nooit koudgrijs. Dark mode is basalt-warm, geen zuiver zwart. Elke token
is `light-dark(licht, donker)` — schrijf beide kanten, altijd.

---

## 3. Typografie

- **Archivo** (`--font-ui`) voor alles; **JetBrains Mono** (`--font-code`)
  uitsluitend voor machinedata (timers, model-id's, paden, diffs, tellers).
- Eén type-ladder — gebruik de tokens, nooit losse px:

| Token | px | Gebruik |
|---|---|---|
| `--text-micro` | 10.5 | meta, tellers, caps-labels |
| `--text-caption` | 11.5 | labels, captions |
| `--text-label` | 12.5 | secundair / beschrijvingen |
| `--text-control` | 13.5 | **UI-standaard** (body van de app) |
| `--text-body` | 14 | leestekst |
| `--text-subtitle` | 16 | kleine titels |
| `--text-section` | 18 | sectiekoppen |
| `--text-title` | 22 | paginatitels |
| `--text-display` | 28 | hero-getallen |

- Koppen: gewicht 500, `letter-spacing: var(--tracking-tight)` (−0.02em),
  `text-wrap: balance`. Leading via `--leading-*` (tight 1.2 / ui 1.45 /
  body 1.55 / relaxed 1.65).
- **Getallen lijnen uit**: alles wat een getal is krijgt `.num` of
  `font-variant-numeric: tabular-nums` (stat-waarden, quota, tellers, timers).
- Utilities: `.num` (tabulaire cijfers), `.caps` (uppercase microlabel),
  `.prose` (68ch leesmaat). Componeer hiermee; verzin geen nieuwe.

---

## 4. Motion

Bewegen is transform + opacity, nooit `width/height/top/left`. Eén easing
(`--ease-out`), duren `--motion-fast/normal/slow` (140/280/420ms). Alles settle-t
vroeg, niets bounct, niets loopt oneindig. De vaste set:

- **Intent-reveal:** één rustige rise per navigatie (`.main-inner > *`), niet
  per kaart.
- **Press-physics:** `scale(0.97–0.98)` op knoppen, nav-rijen, tabs, chips,
  segments. Nooit op inputs, tekst of panelen.
- **Modal:** scrim vervaagt in, kaart rijst en settle-t.
- **Ripple i.p.v. spinner:** `.spin` is een kalm blauw golfje.

`prefers-reduced-motion` zet **alles** uit met nul informatieverlies (globale
guard in `styles.css`). Nieuwe animatie = tokenduur + één keyframe in het
Motion-blok. Meer niet.

---

## 5. Skins (`data-style`)

Dezelfde taal draagt meerdere complete skins:

- `devin` (default) — warm, zacht, ronder (`:root`).
- `strak` — koeler grijs-blauw, scherpere radii.

Zetten: `?style=strak` of een opgeslagen keuze (`localStorage` `ocx-style`),
toegepast vóór eerste paint in `main.tsx`. Een nieuwe skin = één blok
token-overrides in `styles.css` (light **én** dark). De taal (§1–§4) blijft
onder elke skin gelden.

---

## 5b. Taste-regels (overgenomen uit `design-system/taste/`)

Bindend voor nieuw werk. Twee observaties minimum per regel (zie de bron).

- **Kleur:** neutraal warm tinten, **één accent max**; licht is eersteklas
  standaard. Geen paarse gradients, AI-glow, acid-on-black. Het accent is voor
  links/focus/toggles/status — **niet** voor nav-selectie (die is een kalme
  `--raised`).
- **Type:** Archivo/General Sans-humanist voor interface; mono **strikt** voor
  data. Nooit Inter/Geist/Space Grotesk of mono voor labels/prose.
- **Motion:** vroeg settelen, lage amplitude/frequentie; **één** signatuur-
  systeem (de Stroom/ripple), geen verspreide micro-animaties. Geen bounce,
  elastic of oneindige ambient motion.
- **Dichtheid:** compact, informatiedicht (dichtheid 5–7). `h28`/`r6` voor
  secundaire controls, `r10` voor kaarten. Geen marketing-witruimte in product.
- **Stem:** warm, direct, menselijk Nederlands op Joep-vlakken. Geen em-dashes,
  buzzwords, lifecycle-jargon of verzonnen metrics.
- **Structuur:** haarlijnen + ruimte voor scheiding. **Geen** kaart-in-kaart,
  bento-velden of geneste elevation. Tweebaans sidebar met vaste glyph-baan.
- **Iconen:** echte SVG-lijniconen (Lucide/shadcn, ~1.75px stroke, 15–16px
  grid). Nooit emoji als icoon — nergens.
- **Metafoor:** water/stroom voor systeemstatus; instrument-framing
  ("gezandstraald instrument"). Geen keuken/bon/brigade of corporate-dashboard.

## 6. Bans (hard)

- Geen spinners/loaders (ripple vervangt ze).
- Geen emoji als icoon of in copy. Iconen zijn SVG-lijniconen (Lucide-stijl).
- Geen em-dashes, buzzwords of verzonnen metrics in copy.
- Geen gradients, glow, glasmorfisme, bento-kaartjes.
- Geen kaart-in-kaart, geen geneste elevation.
- Geen oneindige ambient motion.

---

## 7. Zo breid je uit

- **Nieuwe kleur/rol:** token toevoegen in `:root` mét `light-dark()`, en in
  élke skin (`[data-style="strak"]`). Nooit een losse hex in een component.
- **Nieuwe component:** hergebruik `.btn`/`.badge`/`.input`/`.switch`/`.seg`,
  radii- en type-tokens. Haarlijn-border, rustige hover, press-physics als het
  klikbaar is.
- **Nieuwe tekst:** géén hardgecodeerde UI-strings in `src/pages`/
  `src/components` (zie `gui/AGENTS.md`). Zet de string in **alle** locale-
  bestanden (`src/i18n/*.ts`) en render met `useT()`. Draai `bun run lint:i18n`.
- **Nieuwe motion:** tokenduur + keyframe in het Motion-blok; transform/opacity
  only; check `prefers-reduced-motion`.
- **Controleren:** `bun run typecheck`, `bun --bun run lint:gui`,
  `bun run lint:i18n`, `bun run privacy:scan`. Zie `AGENTS.md`.
