# OCX — productinterface in herontwerp

## Actuele autoriteit: expliciete redesignopdracht 2026-09-06

Joep heeft voor OCX expliciet een volledig nieuwe identiteit gevraagd: niet de
bestaande ChefGroep/Signaal-stijl, maar moderner, componentgedreven, met betere
verhoudingen en meer motion. Deze sectie vervangt daarom de visuele voorschriften
hieronder voor de nieuwe interface. De historische Signaal-beschrijving blijft
alleen migratiecontext, niet een reden om nieuw werk terug te draaien. Andere
ChefGroep-producten en het gedeelde design-system worden hiermee niet gewijzigd.

### Richting en componenten

Zowel de eerste inkt/mint-richting (werknaam Orbit) als de daaropvolgende blauwe
dashboardcorrectie zijn door Joep afgewezen als generiek. De bestaande runtime is
dus geen visueel geaccepteerd ontwerp. Blauw en paars zijn uitgesloten als merk-,
actie-, selectie- en focusaccent voor het herontwerp; een andere accentkleur op
dezelfde dashboardcompositie is geen oplossing. Het product blijft opencodex.

De catalogusslice vertrekt vanuit het dagelijkse werk: een model vinden,
de bijbehorende provider begrijpen en de bestaande instellingen aanpassen. Een
doorzoekbare modellenlijst met contextueel detail krijgt voorrang boven een
overzicht van zeven even grote getallen. Bestaande verkeer- en gebruiksschermen
blijven bereikbaar; metrics verdwijnen niet, maar bepalen niet automatisch de
hele werkinterface. Geen verzonnen routinggrafiek of nieuwe backend hiervoor.

De voorgestelde basis is monochroom: wit `#ffffff`, lichtgrijs `#f1f1f1`, lijn
`#d4d4d4`, secundaire inkt `#656565`, donker oppervlak `#262626`, inkt `#161616`.
Dit zijn de basisrollen van de branch, geen uitgerolde productie-identiteit. Primaire acties
gebruiken tekst/achtergrond-inversie; selectie gebruikt neutraal vlak plus gewicht
of contour. Groen, amber en rood blijven betekenisvolle statussen met tekst,
niet een nieuw merkpalet. Toets focus en tekstcontrast in beide thema's.
Manrope blijft voorlopig voor interfacecopy, JetBrains Mono voor machinedata:
een nieuwe fontdependency is niet de oplossing voor gebrekkige hiërarchie.

### Onderzoeksbasis en wat we niet kopiëren

- [Raycast, A fresh look and feel (2022)](https://www.raycast.com/blog/a-fresh-look-and-feel):
  zoekveld en contextacties krijgen prioriteit; de actiebalk maakt verborgen
  handelingen vindbaar. [Raycast 2.0 (2026)](https://www.raycast.com/blog/the-new-raycast)
  behoudt deze actiegerichte opbouw. Geen glaslaag of wallpaper overnemen.
- [Resend, domeinverificatie (2023)](https://resend.com/blog/new-domain-verification-experience):
  uitleg en feedback sluiten aan op de gekozen provider en individuele records.
  [Productrebranding (2025)](https://resend.com/blog/rebranding-resend) toont
  objectlijsten als hoofdinhoud. Niet hun logo, serifkoppen of statuskleuren kopiëren.
- [GitButler 0.15 (2025)](https://blog.gitbutler.com/gitbutler-15-quirky-quinceanera):
  werkobjecten en bewerkingen bepalen de ruimte; herstel en selectie zijn onderdeel
  van de interface. Geen commit-lanes nabouwen voor modellen zonder zo'n workflow.

Deze bronnen zijn gedateerde primaire ontwerpvoorbeelden, geen bewijs dat ieder
detail vandaag ongewijzigd is of dat hun vormgeving automatisch bij OCX past.
Ook zwart/neon, crème/terracotta en een krantachtig raster kunnen templates zijn.
Componentlibraries leveren gedrag en consistentie, niet de productcompositie.

Aanvullende referenties van Joep voor de polishlaag:

- [Kinetics](https://kinetics.colorion.co/#library): retargetbare selectie en
  beperkte microfeedback. Geen magneetknoppen, springende cijfers of gekopieerde
  height/left-animaties; de bestaande Motion-laag blijft eigenaar van navigatie.
- [sv-matrix](https://sv-matrix.vercel.app/): een 5×5 midden-naar-buiten motief in
  het lege detailpaneel. `MatrixMark` is een eigen React/SVG-implementatie van het
  motief, geen Svelte-runtime of overgenomen upstreamcomponent. Eén opacity-reveal
  per lege staat, drie ringgroepen, klaar binnen 820ms; geen loader of live-status.
- [Libraries.dev Beam](https://libraries.dev/beam): gerichte randfeedback bij een
  actie. Hier een monochrome lijn langs het model-ID na bewezen kopieersucces,
  met transform/opacity en zonder loop, shader, gradient of extra dependency.
- `GroepOnline/design-system` op `2a8da31`: `DESIGN.md` §15–16,
  `taste/taste-rules.md` en `surfaces/auth-landing.md` bieden relevante
  product-/eerste-indrukdiscipline. Hun historische blauwe accent, loginontwerp
  en branding worden niet naar OCX gekopieerd. Die repo blijft ongewijzigd.

De matrix is verborgen voor assistieve technologie. Reduced-motion toont de
statische eindstaat; toetsenbordgestuurde kopieerfeedback heeft geen lijnbeweging.
Kopieersucces blijft daarnaast leesbare tekst met een check-icoon, nooit alleen motion.

- `WorkspaceNavigation`: één getypeerde bestemmingencatalogus, iconen, labels,
  actieve pagina en een gedeelde Motion-selectie. Bestaande hashes blijven werken.
- Shadcn `base-nova` op Base UI levert de gedeelde Button, Sheet, Empty en
  ToggleGroup in `src/components/primitives/`. Geen volledig preset of tweede
  palet. Bestaande controls, waaronder de authored Select in `src/ui.tsx`, blijven
  eigenaar totdat hun workflow bewust wordt gemigreerd. Zie `UX-CONTRACT.md`.
- Motion for React (`LazyMotion`) verzorgt gedeelde layoutovergangen. CSS behandelt
  eenvoudige hover/press-feedback. Geen React-state-updates per animatieframe.
- Nieuwe dependencies zijn exact gepind en vereisen de bestaande security-review.
- ThreeUI blijft voorlopig eigenaar van de bestaande publieke landing. Die landing
  is nog niet hetzelfde als een volledig herontworpen productpagina.

### Library-componentmigratie — 2026-09-07

Joep vroeg expliciet om daadwerkelijke library-buttons, controls, motion en
spinners, niet alleen inspiratie of losse effecten. De catalogusslice gebruikt
nu officiële shadcn `base-nova`-broncomponenten: Button, InputGroup, Select, Badge,
Switch, Accordion, Field, Alert, Empty, Separator en Spinner. Input/Label/Textarea
zijn hun gedeelde onderbouw. Bestaande Sheet/ToggleGroup blijven in gebruik.

De nieuwe controls vervangen markup in Models en ModelInspector; ze zijn niet
alleen geïnstalleerd. De overige legacy-schermen zijn nog geen volledige migratie.
De pagina houdt state, API-mutaties, selectie en polling; providerkaart/rij/settings,
geavanceerde controls, combo-overzicht en modals zijn afzonderlijke gecontroleerde
componenten. Inspectorvelden zijn eveneens los samengesteld, terwijl focus en
kopieerfeedback hun bestaande lifecycle-eigenaar behouden.
Modelkeuze en API-mutaties blijven eigendom van de bestaande handlers. Catalogus-
visibility gebruikt Base UI `role="switch"`/`aria-checked`; selectie houdt
`aria-pressed`. De providerfilter krijgt een portaled Base UI Select. Legacy
Selects binnen geavanceerde controls en Settings worden niet stilzwijgend vervangen.

Spinners zijn door deze expliciete opdracht toegestaan bij echte pending acties:
initiële catalogusload, providerrefresh en custom-model opslaan. Geen loader in
rust, geen kunstmatige minimumduur; tekst blijft aanwezig en reduced-motion stopt
de rotatie. Accordion-motion volgt de Base UI-paneelhoogte, 180ms, geen max-height
hack; keyboard/reduced-motion opent zonder beweging. Dit verfijnt de eerdere
spinner-ban uitsluitend voor deze gevraagde OCX-opdracht.

Registrybron gelezen via CLI/docs. Aanpassingen blijven in de componentlaag:
geen `transition-all`, geen tweede dark-palet, gelokaliseerde spinner, een expliciete
44×44 touchvariant voor Switch, en transparante Accordion-knoppen zonder afhankelijkheid
van Tailwind preflight. Bronlicentie wordt meegebouwd uit `public/third-party-notices.txt`.
Lucide React is exact gepind op 1.41.0; geen nieuwe transitieve runtimepackages.

### Geometrie en responsiviteit (actueel)

De catalogusslice heeft een werkvlak tot 1800px en een desktopheader van minimaal
64px met merk, globale navigatie en status op één regel. Onder 1280px krijgt de
navigatie een eigen regel. De modellenwerkplek gebruikt een vergelijkbare lijst
en een detailpaneel van 320–400px met een vaste scheidingslijn. Geen drie smalle
zijbalken of een mini-tabel in een grote kaart. Links uitlijnen, model-id's leesbaar
houden en numerieke kolommen uitlijnen. Begin bij 14px interfacecopy, 12px metadata
en 24px paginatitel; toets lange namen en EN/NL vóór verdere verfijning.
Controls mogen compact zijn op desktop, maar primaire touch-acties blijven minimaal
44px. Mobiel toont lijst of detail met een expliciete terugactie en focusherstel,
niet een verkleinde desktop. Bestaande hashes en bestemmingen blijven bereikbaar.
Geen paginabrede horizontale overflow of acties die alleen op hover bestaan.

### Toestanden en motion

Echte API-status blijft leidend: laden, leeg, gedeeltelijk, fout en offline mogen
niet worden vervangen door mooie voorbeeldcijfers. Catalogusvermelding is geen
bewijs van bereikbaarheid, beschikbaar account of daadwerkelijk geserveerd model.
Toon alleen relaties/statussen waarvoor de bestaande API bewijs levert.
Selectiefeedback is direct; een detailovergang mag kort en onderbreekbaar zijn,
zonder de lijst te laten verspringen. Toetsenbordnavigatie en reduced-motion slaan
verplaatsing over. Pagina's voegen zelf geen page-reveal of pressed-translate toe:
route-entree wordt één keer gechoreografeerd door de systeemlaag (zie hieronder).
Sheet opent maximaal 200ms via transform/opacity; toetsenbordopening zonder
verplaatsing, reduced-motion alleen korte opacity-feedback. Focus, contrast en
labels blijven zichtbaar in licht én donker. Onbekende waarden zijn geen nullen.

### Systeemlaag en motion-choreografie (2026-09-12)

`src/styles/ocx-system.css` is de afwerklaag die als laatste laadt en de
werkplekken tot één geheel maakt. Hij bezit de gedeelde tokens voor maat
(`--workspace-measure`, `--page-gutter`, `--section-gap`), kaartgrammatica
(`--card-radius`, `--card-border`, `--card-shadow`, `--card-shadow-raised`),
focus (`--focus-ring`) en motion (`--ease-out`, `--ease-spring`,
`--motion-instant/fast/normal/slow`, `--motion-stagger`). Pagina-specifieke
verfijning staat in `styles/pages-observe.css`, `pages-providers.css` en
`pages-configure.css`; die laden na de systeemlaag en mogen geen tokens
herdefiniëren.

Motion is transform/opacity en kent drie eigenaren. Segmentnavigatie
(`WorkspaceSubTabs`) en paginatabs (`PageTabs`) delen één bewegende indicator per
rail via `layoutId`; pointerselectie veert kort (`visualDuration` 0.22s),
toetsenbord en reduced-motion springen direct. Route-entree gebruikt de
`.ocx-page`-wrapper: directe kinderen rijzen en faden in met een gestapelde
vertraging van `--motion-stagger` per element, afgetopt op 360ms. Controls
(knoppen, toggles, selects, modals) hebben één hover-lift/press en één
menu-in/modal-spring, alle korter dan `--motion-normal`. Geen count-up-getallen,
geen per-frame React-state, geen ambient animatie. Onder
`prefers-reduced-motion` toont elke regel de statische eindtoestand zonder
vertraging.

### Token-eigendom en adapters

Runtime CSS is canoniek, niet een gegenereerde tweede tokenbron:

| Eigenaar                         | Verantwoordelijkheid                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `src/styles.css`                 | Bestaande reset, spacing, semantische status en legacy controls                   |
| `src/styles/workspace-orbit.css` | Actuele kleur-, type-, geometrie- en scrollbarrollen; bestandsnaam is geen merk   |
| `src/styles/app-base.css`        | Cascadevolgorde; legacy CSS in eigen laag                                         |
| `src/styles/primitives.css`      | Tailwind-semantieken verwijzen naar runtime-rollen; geen preflight of eigen palet |
| `src/styles/ocx-system.css`      | Afwerklaag: maat-, kaart-, focus- en motion-tokens; route-choreografie           |
| `src/styles/pages-*.css`         | Pagina-specifieke verfijning per werkplekgroep; hergebruikt systeemtokens         |
| `components.json`                | Officiële shadcn-registry, Base UI-style en gedeelde componentpaden               |

Tailwind `text-xs/sm/base` verwijzen naar `--text-caption/control/body` met hun
line-height. Geen rem-afhankelijke tweede letterladder. Historische `devin/strak`
waarden blijven leesbaar voor compatibiliteit, maar de settings-skinselector is
verwijderd: de nieuwe tokens oversturen beide skins en twee gelijke keuzes zijn
misleidend. Licht/donker/systeem en EN/NL blijven beschikbaar.

### Implementatiestatus en acceptatie

De eerste dashboardcompositie is visueel afgewezen. De daaropvolgende
modellenwerkplek is geïmplementeerd in de redesignbranch, nog niet door Joep
visueel geaccepteerd of uitgerold. `ModelInspector.tsx` vervangt de hoverkaart;
`styles/model-catalog.css` is eigenaar van lijst/detail-geometrie. Zoekfilter en
providerkeuze staan boven de lijst; geavanceerde bediening blijft in disclosures.
Brede schermen tonen modaliteiten als vergelijkingskolom; smallere schermen houden
die informatie in het detailpaneel. Model-ID kopiëren gebruikt de bestaande
clipboardlaag, met succes- en foutfeedback die bij de geselecteerde identiteit horen.
De bestaande API-, locale- en visibilitylogica blijven eigenaar. Verwijderde
selecties worden bij verversen gewist; focus wordt hersteld als die verloren raakt.
Detailpanelen, volledige componentmigratie, landing en volledige visuele acceptatie
blijven expliciete vervolgstappen. Brave-browserchecks van deze slice zijn geen
productie- of brede toegankelijkheidscertificering. Niet als volledig
redesign of live release presenteren zolang die niet aantoonbaar zijn afgerond.
Tokens: `src/styles/workspace-orbit.css`; die worden na de bestaande laag geladen.
Geen nieuwe parallelle app, backend, routing- of authenticatielaag.

---

# Historisch: Signaal-binding vóór de redesignopdracht

> De levende ontwerp- en smaakgids voor het opencodex-dashboard (`gui/`).
> Dit is de ChefGroep-taal (v3 "Signaal"): een stil, warm, mat instrument.
> Bron van waarheid voor de _taal_: [`GroepOnline/design-system`](https://github.com/GroepOnline/design-system)
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

| Rol                        | Token                                                                             |
| -------------------------- | --------------------------------------------------------------------------------- |
| Achtergrond / rail / kaart | `--bg` · `--rail` · `--surface` · `--raised`                                      |
| Lijnen                     | `--border` (sterk) · `--border-soft` (hairline)                                   |
| Tekst                      | `--text` · `--muted` · `--faint`                                                  |
| Primaire actie             | `--accent` (+ `--accent-ink`)                                                     |
| Het accent                 | `--accent-blue` · `--accent-blue-ink` · `--accent-soft` (ring/tint)               |
| Semantiek                  | `--green` (git/PR/toestemming) · `--amber` (wacht-op-jou) · `--red` (destructief) |

Regels: groen/amber/rood zijn **gereserveerd**, nooit decoratie. Neutraal is
warm, nooit koudgrijs. Dark mode is basalt-warm, geen zuiver zwart. Elke token
is `light-dark(licht, donker)` — schrijf beide kanten, altijd.

---

## 3. Typografie

- **General Sans** (`--font-ui`, self-hosted woff2) voor alles; **JetBrains Mono**
  (`--font-code`) uitsluitend voor machinedata (timers, model-id's, paden,
  diffs, tellers). Geen Archivo/Inter/Geist — design-system v3 §11.
- Eén type-ladder — gebruik de tokens, nooit losse px:

| Token             | px   | Gebruik                                          |
| ----------------- | ---- | ------------------------------------------------ |
| `--text-micro`    | 10.5 | meta, tellers, caps-labels                       |
| `--text-caption`  | 11.5 | labels, captions                                 |
| `--text-label`    | 12.5 | secundair / beschrijvingen                       |
| `--text-control`  | 13.5 | **UI-standaard** (body van de app)               |
| `--text-body`     | 15   | leestekst                                        |
| `--text-subtitle` | 15   | kleine titels                                    |
| `--text-title`    | 24   | paginatitels                                     |
| `--text-display`  | 28   | hero-getallen (product-extensie, geen §11-trede) |

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
- **Type:** General Sans voor interface; mono **strikt** voor data. Nooit
  Inter/Geist/Space Grotesk/Archivo of mono voor labels/prose.
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
