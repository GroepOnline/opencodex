# OCX design contract

Locked for PR #238 refinement, 2026-09-12. This document defines the intended
design; [UX-CONTRACT.md](UX-CONTRACT.md) defines behavior and route acceptance.
It replaces the accumulated redesign notes and historical Signaal rules in this
file. Existing CSS is implementation evidence, not proof of design acceptance.
Phase 1 changes these two contracts only. It does not implement or accept the
refinement, authorize a deployment, or start Phase 2.

## Authority and source revisions

Precedence: current user decision, real product/security constraints, these OCX
contracts, applicable ChefGroep surface, extension, profile, generic defaults.
Auth is the quality floor for authorship, composition, complete states,
responsive detail and meaningful motion. Its portal, palette and typefaces are
specific to identity; OCX has its own job and visual language.

Sources were read in the requested order, then checked against the full PR diff
and current route, component and style owners:

| Source                                                                                             | Revision used                                                                        | Contribution                                                                                            |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `GroepOnline/chefgroep-auth`, `DESIGN.md`, `UX-CONTRACT.md`                                        | `534863855c6a9210a9d49564fd78b5b13b0b3359`                                           | Authorship, composition, complete states, honest transactions, focus and settled motion                 |
| `GroepOnline/design-system`, `CHEFGROEP-STANDARD.md`, `surfaces/operator-evidence.md`              | `966aeac01ddb4123fe6dd8438878e8201b282a64`                                           | Product signature, evidence strength/freshness, rows and hairlines, responsive and accessibility floor  |
| Design-system resolved `operator-dense` context and `.agents/meta/chefgroep-design.md`             | Same `966aeac01ddb4123fe6dd8438878e8201b282a64`                                      | Surface selection and precedence; no runtime import or template transplant                              |
| OCX source contracts, `CONTEXT.md`, `structure/05_gui-and-management-api.md`, GUI source and tests | PR head `52ba843484488fca21370a6f71c15ac6dabff3e3`                                   | Actual products, routes, data, state owners and compatibility boundaries                                |
| PR #238 full diff, 133 changed files                                                               | `64409664ab3b8b435a37ebf48cc6eef69e70d296..52ba843484488fca21370a6f71c15ac6dabff3e3` | `main` base equals merge base; includes shared primitives, page slices, styles, locales, docs and tests |

The Auth source files were clean. The design-system sources came from the clean
existing `worktrees/install-main-20260912` checkout at the recorded revision;
its older, dirty `repo/` checkout lacked the requested standard. Neither source
repository was changed. Source inspection establishes provenance, not rendered
or live-runtime verification of this OCX design.

## Visual thesis

**A precise, calm, dense, authored routing instrument for models, providers and
runtime truth. Relationships and current state read before containers.**

The operator should recognize the selected model, its provider context, what is
configured, what was observed and what can be changed without decoding a wall of
equally weighted boxes. Typography, aligned rows, hairlines and purposeful gaps
do most of the work. A provider account, a usage reading and a destructive
confirmation have different jobs and therefore different compositions.

The workspace remains monochrome: neutral selection, inverse primary actions,
semantic green/amber/red with text. Blue and purple remain excluded as brand,
action, selection and focus accents. Changing accent color cannot repair an
undifferentiated dashboard. Do not introduce glass, glow, decorative gradients,
marketing-scale whitespace or a new font dependency to compensate for hierarchy.

## OCX signature: the routing line

Use one recurring, compact **routing line** to make an identity and its evidence
read together. It is an aligned model/provider relationship followed by a quiet
hairline and a labeled state or observation. Its distinctive feature is the
continuity between a selectable row and the same identity in detail, not an
illustration behind the data.

Two readings share this composition without sharing a claim:

| Context    | Content, in reading order                                                                           | Meaning                                         |
| ---------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Configured | Model identity, provider, relevant configured choice, catalog/config source                         | A mapping the configuration or catalog declares |
| Observed   | Request/model identity, reported provider, reported account when present, outcome, observation time | Evidence returned for that request or snapshot  |

Use this line at the head of model detail, provider/account detail, combo target
rows and traffic detail. The selected row and detail repeat the same identifier
and alignment. On narrow screens the order becomes stacked; the relationship
survives without a drawn connector. On broad tables align identity, context,
reading and time columns across rows. One restrained selection rule or neutral
fill marks the current object. Avoid multiple pills around every term.

Use only the segments relevant to the current object. Provider/account detail
starts at the provider and account; it does not invent a selected model. Runtime
evidence uses the actual process or route identity supplied by that surface.
An omitted segment is preferable to a plausible but unsupported relationship.

The line is constrained by real data:

- Model selection is provider-qualified. Catalog inclusion, visibility and
  configured capacity do not prove authentication, reachability or serving.
- Traffic can distinguish `requestedModel`, `resolvedModel`, `model`, `provider`
  and `account` only where supplied. Preserve existing display helpers and
  virtual Pro identities. A provider-name/principal fallback is not proof of an
  account; never promote a parsed suffix into a verified identity.
- A combo's ordered targets and strategy describe configured candidates. They
  are not a recorded sequence of attempts. Do not draw inferred hops or a live
  routing graph. Use an arrow only for a relationship explicitly supplied by
  the relevant configuration or response, with its meaning labeled.
- Account aliases remain display metadata. Active account, reauthentication,
  cooldown and operator quota retain their distinct server-owned meanings.
- Show the source's timestamp when available. A client refresh time may be
  labeled as receipt time, never as the time an upstream probe occurred.
  Missing source, account, outcome or time stays missing/unknown.

This is OCX's application of the operator-evidence principle. Do not add generic
source/CI/deploy stages to pages whose APIs do not expose them. Do not use Auth's
portal or the existing empty-detail matrix as a second product signature.

## Surface hierarchy

Shared components own reusable structure and behavior. A component named
`Panel`, `Stat`, `Inspector` or `Empty` does not require a card appearance.

| Surface             | Use                                                                                     | Treatment                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Workspace canvas    | Route and its working context                                                           | Quiet neutral plane; no enclosing page card                                                       |
| Section             | Related readings, fields or report rows                                                 | Heading, optional hairline and spacing; normally transparent, no shadow                           |
| Row / reading strip | Model, request, endpoint, account metadata, metric                                      | Aligned columns or label/value pairs; hairline separators; no separate tile per reading           |
| Selection rail      | Providers, combos, subagent choices                                                     | Flat adjacent column; neutral selected row and a stable dividing rule; no floating rail card      |
| Detail / inspector  | The selected object's identity and actions                                              | Shared plane across the dividing rule; identity first, fields grouped below; no nested card stack |
| Inset               | Code, JSON, raw diagnostic evidence                                                     | Slight neutral contrast, selectable text, deliberate overflow region; no elevation                |
| Bounded card        | A discrete setup choice or self-contained action/form whose boundary prevents confusion | One quiet border, modest radius, no resting shadow; justify by task rather than component name    |
| Overlay             | Temporary decision, menu, dialog or preferences sheet                                   | Opaque readable surface, border and restrained elevation where needed to separate layers          |

An account list inside a provider is normally rows. A separately actionable
account setup choice may be bounded, but its quota and metadata remain rows
inside it. A destructive region uses separation, a named consequence and a
danger action; it does not turn the whole page red. Every card must answer which
independent choice, transaction or context its boundary represents. If the
answer is merely “a number”, “a section” or “the shared component”, remove it.

No card-in-card layouts, equal-height KPI tile walls, shadows on every panel,
lift on noninteractive readings, or centered framed emptiness in every section.
An empty list uses a short explanation at its row origin. An unselected detail
uses a quiet instruction aligned with the future heading. A first-run setup may
use more space for its next action. Errors belong beside the failed resource.

## Composition by job

**Observe** (`#dashboard`, `#verkeer`, `#verkeer/debug`, `#verbruik`) leads with
the operational conclusion and its scope. Follow with a compact reading strip
and rows linking identity to evidence. Usage is an analytical report: range and
coverage stay next to totals, comparable data stays tabular, and supporting
diagnosis opens below the row or in a dedicated detail region. A current proxy
response never colors every provider healthy. Keep last accepted observations
readable during refresh and separate independently failed resources.

**Providers** (`#leveranciers`, Claude and Grok subroutes) leads with selection
and provider/account context. The rail identifies what can be inspected; the
detail begins with identity, auth mode and relevant state, then local tabs.
Catalog setup, accounts, model discovery, usage and editing remain distinct.
Claude Code/Desktop and Grok use grouped settings rows and a stable save/apply
area. Avoid competing page headings, stacked tab containers and repeated
provider/account summary cards that obscure the selected object.

**Configure** (`#modellen` and its subroutes, `#systeem` and its subroutes) leads
with the object or policy being edited and the scope of the write. Models keeps
search and comparison beside an inspector. Combos places the callable model ID
and ordered targets above strategy detail. Subagent order remains explicit.
System separates restart safety, runtime evidence, storage policy and admission
keys. Use calm form groups and clear draft/saved/applied distinctions.

These are design families, not replacement navigation labels or new routes.
The complete route-by-route acceptance matrix is in [UX-CONTRACT.md](UX-CONTRACT.md).

## Shell, rails and responsive measure

The shell keeps the six current labeled destinations and their hashes. Brand,
version, navigation, proxy status and Settings form one considered header. Keep
runtime status distinct from version identity and preferences. Sub-navigation
appears only for multiple destinations. Route navigation uses one quiet selected
surface; inner tabs use a thin indicator. Do not stack multiple pill frames.

Use one alignment origin for the header, filter row, list columns and detail
heading. The default work measure is 1400px; comparison-heavy Models and
provider/traffic workspaces may use up to 1800px when the extra width improves
reading. Text explanations stay around 60–68 characters per line. Wider space
belongs to useful columns, not inflated cards or centered islands of data.

| Geometry             | Contract                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Main header          | At least 64px on broad screens; it may grow with translated text                                                   |
| Gutter               | 24–48px desktop, 16px phone; align inner content rather than adding another page frame                             |
| Spacing              | 4/8px base rhythm; 8px related controls, 12–16px row/group internals, 24–32px between distinct sections            |
| Provider/choice rail | Approximately 240–280px when side by side; remaining width belongs to the selected detail                          |
| Model inspector      | 320–400px where the list retains useful comparison width; one dividing rule                                        |
| Controls             | 32–38px compact desktop controls where appropriate; primary navigation and coarse-pointer targets at least 44×44px |
| Rows                 | About 36–44px for a single-line desktop row; grow for metadata, errors, localization and touch                     |
| Radius               | 6–8px controls, 8–12px justified bounded surfaces; use semantic roles, not a single global card radius             |

Below 1280px, navigation may occupy a second header row. At tablet widths,
remove optional comparison columns into detail before compressing identity or
actions. Switch from side-by-side list/detail when a useful list plus detail no
longer fits; do not preserve three narrow columns. At 760px and below use six
visible destinations in two rows and one working content column. Models shows
list or detail with an explicit Back action. Other rails reflow above detail or
into a selection view with an equally clear return path.

Preserve selected identity, applicable filters and focus through responsive
changes. Hidden panes contain no reachable controls. Tables requiring comparison
may keep columns inside a named, keyboard-scrollable region; the page itself
must not overflow. Long IDs and endpoints wrap or remain available through
selectable detail/copy. Never ellipsize the only disambiguating part. Sticky
headers, action bars and scrollbars must not cover focus, validation or the last
row. Dialogs fit the visual viewport and remain usable with a software keyboard.

## Typography, color and detail

Manrope Variable is OCX's workspace voice: compact, clear labels and firm
headings. JetBrains Mono carries model IDs, hosts, paths, commands, timestamps
and machine evidence. This pairing makes routing identity readable without
turning the product into a terminal. Ordinary labels and prose remain sans.
Numbers align with tabular figures; numeric emphasis is proportional to the
decision, not automatically 26px in every reading.

| Role                           | Target                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------- |
| Route title                    | 24px / 1.2, weight 600–650, restrained negative tracking; 22px on phones      |
| Section / detail title         | 16–18px / 1.3, weight 600; identifiers may use mono at a readable scale       |
| Controls / data rows           | 14px / about 1.4; weight 400–500, 600 for selected identity                   |
| Explanatory text               | 15px / about 1.55, readable measure                                           |
| Metadata / table labels        | 12–13px / about 1.4; no tiny uppercase wall                                   |
| Important quantitative reading | 22–28px only when it deserves prominence; 14–16px for routine inline readings |

Use existing type and spacing tokens through the runtime cascade. No parallel
Tailwind font ladder. The public landing's existing Instrument Serif import is
legacy implementation context, not the workspace display face or a requirement
to copy the operator template's serif conclusion. The landing must eventually
express the same OCX thesis under its own route acceptance criteria.

Keep current neutral semantic palette roles: light canvas `#ffffff`, rail
`#f1f1f1`, primary ink `#161616`; dark canvas `#161616`, working surface `#202020`,
ink `#f4f4f4`. These recorded roles come from `workspace-orbit.css`; its filename
does not rename the product. Selection, hover, disabled and focus must remain
distinguishable in both themes. Hairlines may be quiet; control boundaries and
focus cannot depend on a barely visible hairline. Meet WCAG 2.2 AA contrast:
4.5:1 normal text, 3:1 large text and meaningful non-text controls/indicators.
Status uses words and symbols as well as color. Forced colors uses system roles.

Light, dark and system are complete themes, including menus, portals, errors,
code insets and scrollbars. Theme changes must not alter information hierarchy.
Preserve existing locale/theme persistence and legacy skin compatibility; do not
reintroduce visually identical skin choices. Use the current SVG icon system,
consistent optical weight and localized names for icon-only actions. Decorative
icons and relationship rules are hidden from assistive technology.

## Motion explains a change

Every animation has a trigger, an object, a meaning and a settled end. Motion
never implies a backend action, measured progress, live traffic or success. It
never delays focus, input, feedback or navigation. All finite timing below
includes delays; all motion settles within 420ms. A status may remain visible
longer than its animation.

| Event                                               | Meaning and allowed movement                                                                                            | Budget                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Navigation or local tab selection                   | One scoped indicator moves to the chosen destination; labels stay above it                                              | 150–220ms, interruptible                          |
| List to detail / provider or account context change | Stable row identity and detail heading explain which object is now inspected; local crossfade or small translation only | 150–220ms; list does not replay                   |
| Accepted state change                               | Replace the affected label/readout and optionally reveal its new evidence once                                          | 90–180ms; no number count-up                      |
| Disclosure                                          | Chevron and newly revealed content explain expansion; no cascading child entrances                                      | 150–180ms                                         |
| Copy confirmation                                   | After clipboard success, text/check plus one line along that identifier; failure gets readable feedback                 | 150–260ms; feedback lifetime stays with its owner |
| Insert/remove/reorder                               | Animate only affected rows where identity continuity benefits; preserve focus, scroll anchor and reading position       | 150–220ms; no replay on every poll                |
| Menu / sheet / dialog                               | Short opacity or small directional movement explains an overlay opening from its context                                | 120–200ms; no bounce or modal spring              |
| Real pending operation                              | Readable pending text and stable geometry; optional single finite cue, then static until resolution                     | At most 420ms; never loop while waiting           |

Keep `MotionConfig reducedMotion="user"`, `LazyMotion features={domMax}`, scoped
`LayoutGroup`/`layoutId` and existing lifecycle owners. `domAnimation` lacks the
layout support needed by the travelling indicators. Preserve the sub-tab
stacking fix: the moving indicator never obscures any label. Retarget rapid
pointer selection without queuing transitions. A critically damped, zero-bounce
spring is allowed only for selection continuity if it meets the duration and
interruption contract; it is not a general interaction easing.

Remove the design mandate for `.ocx-page` rise/fade and child stagger, generic
`.ocx-reveal-list` entrances, hover lifts, press scaling of navigation/data,
rotating Settings icons, empty-state pops and spring-loaded dialogs/toggles.
Hover communicates affordance through static tone/border changes. Initial route
content appears immediately. Polling does not replay the page or list.

Keyboard-driven selection and opening use the final composition immediately.
Keyboard copy feedback uses the text/check state without line movement.
Reduced motion disables displacement, scaling, rotation, springs, stagger,
animated progress and decorative reveals, with no information loss or delay.
Pending indicators become static. The existing Spinner and MatrixMark components
are not authority for indefinite rotation or decorative choreography. MatrixMark
may remain a static, aria-hidden empty-detail aid, never a health indicator.
The same no-loop rule applies to the landing's current particle scene.

Prefer transform/opacity and Motion layout projection, with no per-frame React
state. Preserve the narrow existing Base UI Accordion height transition when it
explains disclosure: measured content height, 180ms maximum, no max-height hack,
instant for keyboard/reduced motion. No new blanket geometry animations. Overlay
positioning must not inherit a transformed route as its containing block.

## Runtime ownership and PR review

`src/main.tsx` establishes the actual import order. `styles/app-base.css` places
legacy `styles.css` in its cascade layer; `workspace-orbit.css` supplies OCX
semantic palette/type roles; `model-catalog.css` owns catalog composition;
`primitives.css` adapts the same roles for Base UI/shadcn. `ocx-system.css` and
the three `pages-*.css` files currently finish the cascade. Refinement must use
this path and shared controls rather than add a second theme or UI runtime.
Source attribution stays in `public/third-party-notices.txt`. Dependencies and
security changes retain repository review requirements.

The source comparison at `52ba8434` produced these contract decisions:

| PR evidence                                                                                             | Refinement decision                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ocx-system.css` applies one radius/shadow grammar to `.panel`, `.card`, `.stat` and `.stat-strip-item` | Use the surface hierarchy above; retain semantic primitives without forcing their visual enclosure                 |
| Reading strips become grids of bordered tiles; every empty state gets a centered frame                  | Restore aligned readings and contextual empty states; choose grouping per task                                     |
| Provider rail, API-key rows and other page styles repeat raised-card treatment                          | Flat selection rails and metadata rows; bounded actions only where justified                                       |
| Keyed `.ocx-page` animates routes and children; list helpers animate again                              | Keep route lifecycle behavior, remove generic motion as a design requirement; scope motion to meaningful events    |
| Prior contract says 360ms total; CSS caps the delay at 360ms and adds a 420ms animation                 | Timing must include delay; the old statement is not an accurate account of this PR                                 |
| Shared indicators gained `domMax` support and protected label stacking                                  | Preserve both fixes while reducing bounce and surface weight                                                       |
| `Modal` and `WorkspaceDialog` include presentation/ARIA wrappers; behavior remains with callers         | A wrapper name or `aria-modal` is not proof of focus containment, dismissal or focus return                        |
| Many new tests assert primitive/class presence                                                          | Keep useful regression coverage; class assertions do not establish visual quality or complete interaction behavior |

## Acceptance and remaining design decisions

Acceptance requires the route criteria in [UX-CONTRACT.md](UX-CONTRACT.md), real
light/dark desktop/phone renders and interaction evidence. The first viewport
must identify task, selection and evidence without relying on box outlines. All
readings must remain interpretable in a static, monochrome view. Every bounded
surface and animation must have the purpose specified above.

The thesis, signature, surface hierarchy, typography, state meanings and motion
policy are locked. Remaining design decisions are limited to optical tuning of
row height, column widths and the exact list/detail collapse point within the
specified ranges, based on real long IDs, EN/NL copy and phone renders. Final
visual acceptance by Joep is not inferred from these documents or tests. The
current landing illustration/type treatment also requires a separate rendered
assessment against this contract; its legacy appearance is not grandfathered
into acceptance. No implementation work follows from Phase 1 alone.
