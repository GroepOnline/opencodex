# OCX UX contract

Locked for PR #238 refinement, 2026-09-12. [DESIGN.md](DESIGN.md) owns the visual
thesis, routing-line signature, typography, surfaces and motion. This document
owns product behavior and explicit route acceptance. Requirements describe the
refinement target; they do not assert that every current route already meets it.
Phase 1 rewrites only these two files and ends at a local documentation commit.

## Sources and precedence

The reviewed OCX source is `52ba843484488fca21370a6f71c15ac6dabff3e3`; the full
PR diff is from `64409664ab3b8b435a37ebf48cc6eef69e70d296` (PR base and merge
base). Auth `DESIGN.md` and `UX-CONTRACT.md` were read at
`534863855c6a9210a9d49564fd78b5b13b0b3359`, followed by design-system
`CHEFGROEP-STANDARD.md` and `surfaces/operator-evidence.md` at
`966aeac01ddb4123fe6dd8438878e8201b282a64`. The source register and checkout
provenance are in [DESIGN.md](DESIGN.md#authority-and-source-revisions).

Current user decisions and real domain/security constraints precede aesthetic
preferences. Existing handlers, schemas, APIs, hash behavior and lifecycle owners
remain authoritative. This contract does not redesign the backend or import
Auth's account, consent, locale or permission model into OCX. Terms follow
[CONTEXT.md](../CONTEXT.md); management boundaries follow
[the management specification](../structure/05_gui-and-management-api.md).
Where older prose names a retired route, current `App.tsx` and
`app-routing.ts` determine what actually mounts.

## Product truth and security

The audience operates the local Bun-native proxy: find models, understand
providers/accounts, configure routing and inspect what actually happened.
The GUI is served by that proxy, not a separate control service.

Visible copy uses the existing i18n layer: English is the key source and every
supported locale must receive UI changes, currently EN/NL. Machine IDs, code and
protocol literals follow `gui/AGENTS.md` exceptions. Preserve existing Intl/date
formatters and timezone behavior; do not import Auth's Dutch/Amsterdam policy.

- Distinguish configured, discovered, selected, visible and observed. Selecting
  a model for inspection never changes routing. Visibility is catalog policy,
  not proof that an authenticated account can serve a request.
- Availability owns active credentials, cooldowns and cap-disable decisions.
  Operator quota is a separate read model. A full-looking quota bar, catalog row
  or successful leaf probe cannot establish provider or system-wide health.
- Preserve requested versus resolved model evidence where exposed. Virtual Pro
  catalog IDs remain public identities even when transport evidence names a
  resolved base model. Combo target order is configuration, not observed hops.
- Unknown, unsupported, unreported, stale, partial, disabled, unauthenticated and
  failed are distinct. A missing number is not zero. Cost is an API list-price
  equivalent with its coverage/estimation caveats, never a billing receipt.
- Account IDs, auth state and reauthentication results come from the existing
  server/controller. Aliases are display-only. Keep one Codex-login OpenAI
  provider entity and Models group, distinguish Pool and Direct, and keep the
  main account within Pool. The API-key provider remains a separate auth choice.
- Data-plane keys admit `/v1/*`; management credentials and origin-bound GUI
  sessions admit `/api/*`. No loopback management bypass. A successful
  unauthenticated `/healthz` request proves neither management access nor
  upstream availability. Management-unavailable 503 remains a service error.
- GUI sessions are memory-only, five-minute, exact-origin sessions. Preserve
  session rebootstrap, the shared 401 resolution gate, cancellation behavior,
  and CSRF headers for session writes. Never store tokens in browser storage,
  put them in URLs, or attach management/session credentials to `/v1/*` or a
  cross-origin request. Do not add another login or credential store.
- Keep masked keys masked. Never round-trip a masked API key as a secret; full
  `PUT /api/config` remains disabled. Use the existing narrow mutation paths.
  Newly created keys may be shown only by the existing explicit creation flow;
  account rows, summaries, screenshots and telemetry must not reveal secrets.
- Preserve opt-in diagnostic controls and their warnings. Normal usage summaries
  contain no prompts. Diagnostic payloads, provider responses and Claude Desktop
  library exports may be sensitive; never promote them into summaries or log
  them to analytics. The Desktop library can contain `inferenceGatewayApiKey`.
- Dashboard/management embedding stays unsupported. Keep same-origin admission,
  no-store session/bootstrap handling and the server's frame protections.
  Removing a data key must not claim to terminate an already established
  WebSocket; that behavior is outside the current admission contract.
- `codexAutoStart`, a tray icon and a running proxy do not establish restart
  protection. Preserve platform-specific service/shim evidence, allowlisted
  repair actions, refusals and recovery. Saving a profile does not mean it was
  applied, and applying on the proxy host does not prove laptop installation.

Phase 1 changes no authentication, credential, dependency or runtime code. Its
security analysis is preservation of these boundaries: cosmetic success cannot
replace server acceptance, and composition cannot expose a secret or collapse
independent trust states. Future changes at a security boundary require the
analysis and checks in [MAINTAINERS.md](../MAINTAINERS.md).

## Current ownership

Paths below are relative to `gui/` unless they start with `../`.

| Capability           | Owner                                                                                                      | Contract to preserve                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Routes and shell     | `src/App.tsx`, `src/app-routing.ts`, `src/use-app-route-state.ts`, `src/hash-routing.ts`                   | Canonical hashes, deliberate history pushes, passive normalization, title and lazy error boundary    |
| Route navigation     | `WorkspaceNavigation`, `WorkspaceSubTabs` in `src/components/`                                             | Labeled destinations, one `aria-current="page"` per navigation, scoped shared-layout indicator       |
| Inner tabs           | `src/components/primitives/page-tabs.tsx` and page-owned handlers                                          | Tab/panel IDs, roving focus, Arrow/Home/End, dirty-change guards                                     |
| Selection and writes | Page/controller hooks and the management API                                                               | Stable identity, single-flight writes, existing polling/race guards, server refresh                  |
| Models and inspector | `src/pages/Models.tsx`, `ModelInspector.tsx`, `models-*.tsx`, `src/models-groups.ts`                       | Provider-qualified selection, independent visibility, discovery provenance, full-provider bulk scope |
| Provider/accounts    | `src/pages/Providers.tsx`, `use-providers-*.ts`, `src/components/provider-workspace/`, account controllers | Provider context, one shared Codex pool controller, masking, actual account capabilities             |
| Form controls        | Shared Base UI/shadcn primitives and authored `src/ui.tsx` Select                                          | Reuse actual controls; do not replace their semantics with styled divs                               |
| Preferences          | `src/components/SettingsSheet.tsx`, Sheet, ToggleGroup, `src/i18n/`                                        | Light/dark/system, EN/NL, persistence and modal focus lifecycle                                      |
| Clipboard            | `src/components/use-copy-feedback.ts`, `src/oauth-health-display.ts`                                       | Real clipboard outcome, identity/generation scoping, timer cleanup                                   |
| Modal presentation   | `modal.tsx`, `workspace-dialog.tsx`, Sheet; each caller's lifecycle                                        | Native dialog/Base UI behavior or explicit focus management; wrappers alone do not trap focus        |
| Readings             | Metric/Stat/DataList/Status/Timestamp/ProgressTrack primitives                                             | Source values and semantics; no requirement to render cards or to turn unknown into zero             |
| CSS and motion       | Cascade documented in `DESIGN.md`; `MotionConfig`, `LazyMotion domMax`                                     | One runtime token path, intact layout support, local finite transitions                              |

Current catalog controls include actual Base UI Button, InputGroup, Select,
Badge, Switch, Accordion, Field, Alert, Empty and Spinner components. Keep their
behavior and source attribution. The catalog provider filter uses the library
Select. Other authored Select consumers retain their owner; Settings uses its
inline popup. Closed catalog Accordions unmount. Textareas retain usable editing
space and vertical resize until an equally usable expansion behavior exists.

## States and recovery, on every data surface

State belongs to a resource and query identity, not to a page-wide green badge.
Apply this matrix to each route below, including nested lists and overlays.

| State                          | Required presentation and behavior                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial loading                | State what is loading; preserve useful geometry, headings and navigation. No zero metrics, successful empty state or fabricated rows. Static skeletons are allowed.             |
| Loaded/current                 | Render the accepted result with its scope; zero is valid when actually returned. Include source/freshness where available.                                                      |
| Empty success                  | Say which collection or period is empty and offer its real next action. Do not conflate no providers, no accounts, no traffic, no selection and no search matches.              |
| Filter has no results          | Keep the filter and offer clear/reset; preserve the underlying data and full-provider bulk-action scope.                                                                        |
| Background refresh             | Keep the last accepted snapshot for the same resource/query. Show refresh state without remounting the page or resetting focus.                                                 |
| Partial / unsupported          | Keep valid areas readable; name the missing or unsupported capability. Never synthesize a total from incomplete parts or enable an unsupported action.                          |
| Stale / refresh error          | Keep same-query last-good content, mark the failed refresh and offer retry where supported. Preserve actual source time; never advance it on failure.                           |
| First-load error / unavailable | Show unknown values or a resource error with retry/recovery. No simultaneous “nothing here yet” success. Distinguish management rejection from proxy unreachability when known. |
| Permission / expired session   | Preserve the existing auth-resolution flow and honest refusal/cancel state. No repeated prompt storm, invented access or fabricated accounts.                                   |
| Dirty draft                    | Keep edits and explicit save/revert context. Background GETs cannot silently overwrite a dirty policy/profile. Existing unsaved-leave confirmations remain.                     |
| Pending write                  | Name the action and target; prevent duplicate/conflicting submissions through existing guards. Reserve label/icon space so controls do not jump. No premature success.          |
| Write success                  | Announce only the accepted result; refresh through the existing owner. Distinguish saved, applied, switched, restored and actually observed.                                    |
| Write failure / conflict       | Keep the relevant draft/context where safe; show actionable server feedback and the existing retry or revalidation path. Do not erase error details needed for recovery.        |
| Render failure                 | Keep shell/navigation usable, identify the affected view and provide the existing error-boundary retry. Do not print credentials or request bodies.                             |

A stale label requires actual stale evidence or a known failed refresh; do not
invent a freshness SLA. If the API has no observation time, omit it or label the
known client receipt time precisely. Resource keys must include relevant range,
surface, provider and account identity; a late response must not relabel another
selection. Preserve bounded polling, abort/generation guards and pause-on-hidden
behavior where already present. Do not change polling cadence for animation.

## Navigation and route inventory

The live route owner is `src/app-routing.ts`, consumed by `App.tsx`.
`src/route.ts` is an older compatibility parser, not the current shell catalog.
Observe, Providers and Configure are design families; they do not replace the
six existing navigation destinations or rename their hashes.

| Canonical hash         | Current mounted surface                        | Family                       |
| ---------------------- | ---------------------------------------------- | ---------------------------- |
| `#landing`             | `landing/Landing.tsx`, outside dashboard shell | Public entry                 |
| `#dashboard`           | `pages/Dashboard.tsx`                          | Observe                      |
| `#leveranciers`        | `pages/Providers.tsx`                          | Providers                    |
| `#leveranciers/claude` | `pages/Claude.tsx`, local Code/Desktop tabs    | Providers                    |
| `#leveranciers/grok`   | `pages/Grok.tsx`                               | Providers                    |
| `#modellen`            | `pages/Models.tsx`                             | Configure                    |
| `#modellen/combos`     | `pages/Combos.tsx`                             | Configure                    |
| `#modellen/subagents`  | `pages/Subagents.tsx`                          | Configure                    |
| `#verkeer`             | `pages/Verkeer.tsx`                            | Observe                      |
| `#verkeer/debug`       | `pages/Debug.tsx`                              | Observe                      |
| `#verbruik`            | `pages/Usage.tsx`                              | Observe                      |
| `#systeem`             | `pages/Startup.tsx` plus shell DangerZone      | Configure / runtime evidence |
| `#systeem/storage`     | `pages/Storage.tsx`                            | Configure                    |
| `#systeem/api`         | `pages/ApiKeys.tsx`                            | Configure                    |

`#providers` and `#codex-auth` resolve to Providers; `#models`, `#combos`,
`#subagents`, `#claude`, `#grok`, `#logs`, `#debug`, `#usage`, `#startup`,
`#storage` and `#api` retain their existing canonical destinations. Preserve the
full legacy map, including `#dashboard/providers`, `#dashboard/models`,
`#providers/workspace` and `#logs/debug`. Accept the existing `#/` normalization.
Unknown hashes fall back to Dashboard, invalid subroutes normalize through the
existing resolver, and only explicit `#landing` enters the public landing.

User navigation pushes history; passive correction replaces it. Back/Forward
must not trap users on a normalized hash. Titles use the localized route name
plus opencodex; the landing keeps the product title. The route container remains
keyed by its canonical route. Do not retain hidden editors/pollers merely to
animate route transitions.

Shell acceptance: all six labeled destinations and Settings remain reachable at
390px and 200% zoom. A single-destination route has no redundant Overview strip.
Main/sub-navigation buttons keep route semantics, native activation and visible
focus; inner `PageTabs` keep tab semantics. The proxy stamp is unknown while the
first health request is pending. Its success means `/healthz` responded, not that
all providers work. The displayed version may fall back to `__APP_VERSION__`;
that fallback is GUI build identity, not verified runtime provenance. Offline
feedback keeps the System recovery link and does not block navigation.

## Route acceptance

Each entry inherits the full state matrix, responsive/light/dark requirements,
keyboard rules and motion contract. Acceptance requires its listed primary
workflow plus first-load failure, empty success where meaningful, refresh
failure and recovery. These criteria are requirements, not a claim that the
head already passes them.

### Dashboard: `#dashboard`

The first viewport distinguishes proxy/runtime state from 30-day usage and
recent activity. Use compact readings and two related provider/traffic lists,
not equal KPI cards. Provider rows identify the provider and actual share;
recent requests link identity to outcome. Provider and traffic links navigate
to the current destinations. Independent failures do not erase valid readings.
Unknown first-load metrics are not zero; successful zero remains zero. Verify
one failed resource beside a successful one and retry/refresh recovery without
replaying the lists or announcing every poll.

### Providers: `#leveranciers`

Searchable provider rail and selected detail share the routing identity. The
first-run empty state offers the existing add-provider/catalog flow; a filtered
empty rail offers filter recovery. Detail retains Overview, Models, Usage,
conditional Accounts/API Keys and Settings. Unsupported account tabs do not
appear as working capabilities. Verify provider test and refresh outcomes,
disabled-provider restrictions, live/static/passthrough discovery, missing quota,
account loading/error/retry, active switch/reauth and existing delete confirmation.
Settings preserves JSON validation, dirty-leave protection and masking. One
shared Codex account controller supplies overview and detail. Pool/Direct and
API-key mode remain distinct; selecting a row does not switch an account.

### Claude: `#leveranciers/claude`

Code/Desktop are local accessible tabs under the existing route, not new URLs.
Both panes retain their current draft-preserving mount behavior; Desktop polling
pauses while hidden. Claude Code uses a settings rail and grouped editable rows
with save feedback. Claude Desktop keeps profile identity, dirty/saved/applied/
stale state and relevant actions together. Verify loading, fetch failure/retry,
invalid editing, save/apply failure and success, import/export and the laptop
sync handoff. Proxy-host application must not be presented as confirmed laptop
application. Keep sensitive library content within its explicit existing flow.
Long settings and action bars remain usable on phone and keyboard.

### Grok: `#leveranciers/grok`

Lead with configuration/profile context and its real state, then collapsible
settings groups and a stable save/apply area. An absent configuration is a normal
setup state, not a failed provider. Verify loading, retryable fetch error, dirty
editing, save versus apply, failure feedback and successful refresh. An apply
skipped by policy remains skipped with its reason; it is never “applied”. Collapse
controls expose their expanded state and keep focus; opening a group does not
replay unrelated groups. No implied live routing proof from a saved profile.

### Models: `#modellen`

Search, provider filtering and comparable model rows lead; detail repeats the
selected provider-qualified identity, copyable ID, known capabilities and
catalog provenance. Selection and visibility are separate controls (`aria-pressed`
versus switch `aria-checked`). Selecting focuses the inspector heading; Back
restores the originating row, or search when it no longer exists. Narrow detail
hides list/header/filter controls from the tab order. Verify duplicate bare IDs
across providers, removed selection on refresh, no matches, empty provider,
discovery failure, missing context/modalities, copy success/failure and custom
model validation/confirmation. Copy routed namespaced IDs and bare native IDs
according to the existing handler. Search may open matching groups without
rewriting saved collapse preferences; bulk actions still cover the full provider.
Keep advanced cap, V2 and other existing controls in disclosures, including
optional-endpoint unavailable states. Writes retain existing single-flight and
catalog-refresh behavior. Provenance remains understandable when collapsed.

### Combos: `#modellen/combos`

A choice rail and detail show the callable combo ID, ordered targets and strategy
before supporting settings. The routing line describes configured candidates,
never a history of attempts. Verify first-combo creation and focus handoff,
search-empty state, validation, rename, target editing/order, save, removal and
unsaved selection change. Canceling a leave/remove dialog preserves the current
draft and selection. Error notices remain actionable; a success notice describes
only the completed write. Editor/About tabs keep addressable panel shells and
single selection. No hidden duplicate editors are mounted for animation.

### Subagents: `#modellen/subagents`

The featured ordered list and candidate selection are visually distinct.
Show the current count and maximum of five from the existing
contract; keep full/busy controls disabled and ordering keyboard-accessible.
Verify empty featured list, search, add/remove/reorder, save failure and recovery.
This route manages `/api/subagent-models`; it does not currently expose the
separate guidance, injection-model/effort or native-default-sync APIs. Do not add
those controls as part of visual refinement. Preserve their separate domain
semantics and default-off opt-ins wherever applicable. A featured selection does
not prove that delegation occurred or that an existing Codex task adopted it.

### Traffic: `#verkeer`

Show scoped traffic readings above a dense provider/model/principal/outcome
rail. Filters, Pause/Follow and Analysis/Operations disclosures stay close to
the data. Operations retains response-cache and key-pool health controls.
Expanded rows keep real request IDs, errors and usage detail where present.
Verify no traffic versus failed load, filtered-empty, last-good refresh failure,
unknown usage/cache readings and recovery. Preserve pause-on-focus and existing
bounded tail behavior; inserts must not move focus or pull the reader away from
an expanded row. A bounded recent tail is not the durable aggregation source.
Keep Anthropic prompt-cache token reuse (`summary.cacheReadRatio`) separate
from proxy response-cache hits/lookups (`/api/response-cache`). Absent, off or
unprobed proxy cache is unknown, not 0%. Do not add legacy Logs filters or its
detail modal to this route by implication.

### Debug: `#verkeer/debug`

Keep the debug flags, provider/usage/injection stream choice, Refresh/Follow and log viewport in a clear
control-to-output relationship. Disabled logging, enabled-but-empty, loading and
fetch failure are distinct. The Claude inbound feed stays separately gated by
its debug flag. Preserve active-only polling, monotonic cursor,
bounded/virtualized lines, serialized mutations and busy controls. Verify toggles,
reset, stream change, manual refresh, follow/pause, failure and recovery with
keyboard access to the viewer. Diagnostics remain opt-in; do not invent logging
activity or include sensitive diagnostic payloads in summaries or telemetry.

### Usage: `#verbruik`

Compose a report with range (`all`/`30d`/`7d`) and surface
(`all`/`codex`/`claude`/`grok`) filters, totals and coverage, then comparable
model/provider/day breakdowns. Keep units and the measured/reported/unreported/
unsupported/estimated distinctions. Lists and plots have readable text/table
context. Verify range/surface changes, empty period, first error with retry,
same-query stale data and recovery. Old-query responses must not populate a new
filter selection. Cost remains a list-price estimate with coverage, never a
charge. Missing usage is not zero and provider share is not health.

### System: `#systeem`

Lead with restart-safety conclusion and its service/shim evidence. Settings,
repair commands, updates, memory/runtime detail and Stop are separate sections,
not equally weighted status cards. Verify initial loading/error/retry, partial
platform support, settings write, allowlisted startup action and refusal/recovery.
Tray presence and auto-start preference never upgrade protection status. Memory
is read-only service-process evidence, not fleet-wide health. Update progress
uses actual job state; starting a worker is not completed installation. Stop
remains in the named DangerZone with Cancel initially focused, an explicit
consequence and duplicate-submit protection. Preserve refusal/restore-failure
feedback and the existing stop outcome handler; never reinterpret every network
failure as a successful stop.

### Storage: `#systeem/storage`

Separate the storage inventory, policy draft, cleanup preview and job/restore
history through headings and rows. Show which data and scope each action affects.
Verify empty inventory, loading, partial scans/errors, policy validation/save,
dirty draft during refresh, preview staleness, conflicts, running work, cleanup
confirmation and restore confirmation. Preserve the existing confirmation gates,
Escape and focus return, server checks and recovery. A preview is not a cleanup,
a queued job is not a completed job, and background data must not overwrite
unsaved policy. Destructive actions remain visible and clearly scoped on phones.

### API keys: `#systeem/api`

Keep endpoint instructions, admitted model list and key administration distinct.
Use readable endpoint rows and key metadata rows (name, prefix, created time),
with explicit copy/create/remove actions. Verify key creation's existing secret
reveal lifecycle, clipboard failure, empty/search-empty states, fetch failure,
refresh recovery and the delayed two-step deletion confirmation. Never expose
full keys in the regular list. Preserve the data-plane model-list attempt and
filtered management-model fallback without sending the GUI session to `/v1/*`.
Preserve the existing per-model test action, its pending/error/result state and
real data-plane request. An admission rejection remains an error; never add a
management credential to make the test succeed.
Long URLs/model IDs remain inspectable at narrow widths; endpoint copy does not
claim a successful API call.

### Public entry: `#landing`

The landing remains explicit and outside shell navigation/health polling. Explain
the actual proxy product and preserve docs/GitHub/install/dashboard actions and
internal anchor behavior. The dashboard link is navigation, not an implemented
Auth sign-in transaction. Static terminal examples and endpoint/provider samples
must be clearly illustrative, never presented as current runtime readings or
customer proof. No fabricated quota, routing success or installed version claim.
Verify lazy-loading failure/retry, canvas-unavailable and reduced-motion fallback,
keyboard anchors, phone layout and both themes. Meaningful copy and actions must
work without the decorative scene. The current ThreeUI particle renderer and
word entrances are implementation debt against the no-loop, immediate-content
contract; they are not accepted motion or a second OCX signature. Landing has no
data-collection empty state to fabricate.

## Preferences and retained compositions

The Settings sheet is available from every shell route. It contains language
and light/dark/system preferences, not provider credentials or Stop. Opening
focuses Close; Tab/Shift+Tab stay inside; closing restores the external opener.
Escape closes an open locale Select first, then the sheet. The locale popup stays
inside modal containment and fits its trigger/viewport. Exactly one theme remains
selected. Verify EN/NL changes, theme persistence, blocked browser storage,
keyboard/reduced-motion opening and both pointer/keyboard dismissal. Selection
updates the existing preference owner; there is no server-write success claim.

The PR also changes retained compositions that the live shell does not mount:

| Retained surface         | Acceptance when used or tested                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/Logs.tsx`         | Preserve request/runtime tabs, filters, optional auto-refresh, virtualized rows, session cache and detail-modal keyboard/focus behavior; do not confuse it with current `Verkeer` |
| `pages/Modellen.tsx`     | Preserve compatibility tab targets; inactive panels are addressable empty shells, not hidden editors/controllers; live App mounts Models/Combos/Subagents directly                |
| `pages/Instellingen.tsx` | Preserve its composed settings behavior when used; it is not the shell's `SettingsSheet` and creates no additional route                                                          |

## Overlays, forms, keyboard and focus

Use the current modal family and lifecycle owner. Native `dialog` and Base UI
Sheet behavior must survive composition changes. `Modal`/`WorkspaceDialog`
wrappers alone do not provide modal focus management. For every actual overlay:

- Give it a localized accessible title, relevant description and explicit
  Cancel/Close where the operation permits. Identify the provider, account,
  combo, key, storage scope or proxy affected by a write.
- Put initial focus on the safe action for destructive confirmations, on Close
  for Settings, or on the appropriate input for creation. Preserve existing
  specific choices. Focus invalid fields and associate their error text.
- Contain Tab/Shift+Tab, keep nested popups inside the active modal, and dismiss
  the innermost popup first with Escape. Respect existing pending/dismissal and
  unsaved-work guards. Do not let backdrop clicks silently discard protected work.
- Restore focus to the still-connected opener; if removed, use the nearest
  surviving row or section action. Cleanup must release modal/focus state.
- Fit the viewport at phone size and zoom. Long dialog bodies scroll while title,
  validation and actions remain reachable. No clipping behind sticky chrome,
  transformed page ancestors, or an unrelated portal's stacking context.

Provider/account login flows retain their actual stages and bounded polling.
An accepted manual OAuth code disables resubmission and announces that it was
accepted; it does not mean login completed. Polling failures remain visible while
waiting. Success, failure, expiry/cancel and identity mismatch keep their existing
recovery paths. Provider terms/risk acknowledgement stays an explicit decision.
Account switching, reset and removal keep their target context and confirmations.

Keyboard is a complete input mode, not a reduced set of mouse actions. Keep
native buttons, links, labels, switches and forms. Use a working skip path to
main content, meaningful heading hierarchy, visible focus and accessible names
for icon-only controls. No action exists only on hover. Inner tabs have one
`tabIndex=0`, valid `aria-controls`/`aria-labelledby`, wrapping Left/Right and
Home/End behavior. Respect page-specific dirty guards and browser shortcuts;
Tab exits the tablist normally. Route navigation remains navigation rather than
being recast as an ARIA tablist.

Selection, visibility, disabled, pending, focus and active-account state need
separate semantics. Hidden panels are not focusable. Preserve empty tabpanel
shells where tests require addressable targets without mounting hidden work;
Claude's explicitly retained editor panes have their own lifecycle contract.
Success feedback is polite, failures use an appropriate alert, and background
polls do not repeatedly announce unchanged rows. Copy feedback is scoped to the
selected identity and reports the real clipboard result; an earlier completion
must not overwrite a later attempt. Never rely only on animation or color.

## Responsive, theme and motion acceptance

Apply the measures and surface hierarchy in [DESIGN.md](DESIGN.md). On narrow
screens show one usable task at a time, with selection context and a return path;
never shrink a desktop workspace until IDs and actions become unreadable.
Meaningful tables may scroll horizontally inside a named focusable region.
No page-wide horizontal overflow, clipped focus ring or hidden primary action.
Keep coarse-pointer controls at least 44×44px; fine-pointer controls still meet
WCAG 2.2 AA target-size/spacing requirements. Long IDs, EN/NL text, empty and
error states must receive the same care as populated desktop screens.

Both themes cover every surface, including portals, diagnostic insets, disabled
controls, alerts, focus and scrollbars. System theme follows the existing owner.
Contrast is checked in the rendered state, not inferred from token names.
Forced colors keeps selection/focus understandable and uses native scrollbar
colors. At 200% zoom reflow preserves controls, labels and validation.

Motion is limited to selection continuity, list/detail or provider/account
context, real state changes, disclosure, clipboard confirmation and relevant
inserts/removals. All timing, including delay, follows DESIGN's finite budgets.
No ambient loops, generic route-wide rise/stagger, hover lifts, number count-up
or spring-loaded dialogs. Keep Motion's `domMax` layout capability and label
stacking fix. Reduced motion and keyboard-driven transitions show final states
immediately. Pending actions stay understandable with a static indicator.

Verify rapid retargeting, repeated copy, cancel during a permitted transition,
row removal and background refresh while focus is inside a list. Nothing may
queue obsolete animation, delay navigation, change state on animation completion
or steal focus. A running animation is never an indication that a request is
actually in flight. Decorative graphics stay out of the accessibility tree.

## Verification and known gaps at the reviewed head

Phase 1 verifies contract coverage against source and the full PR diff. It does
not claim browser acceptance, production health, provider CRUD execution or a
screen-reader certification. No CSS, TS/TSX, tests, runtime or backend files are
changed in this phase.

The following source findings are acceptance gaps, not completed improvements:

- `ocx-system.css` applies card styling to unrelated sections/readings and one
  centered empty-state grammar; page styles reinforce raised rails/key rows.
- Route/list rise and stagger, generic hover lifts, broad spring easing and
  looping/decorative legacy motion do not meet the new motion policy.
- Current state completeness varies: for example, Verkeer retains usage/cache
  results silently on failure and has no distinct initial-loading treatment for
  all upper readings; Debug silently catches log-fetch failures. The common
  matrix requires visible, scoped states.
- Current wrapper/class tests do not prove modal containment, target dimensions,
  optical composition, real motion timing or phone usability. Do not call these
  behaviors verified solely because a shared primitive is present.
- The landing's static examples, type/illustration and current motion require
  their own rendered assessment. No live claims can be derived from its samples.

For later authorized implementation, prove each applicable route workflow above
with controlled success, loading, empty, partial, error and recovery data. Use
fixtures for repeatability and label them as fixtures. Test actual mutations only
against a safe, authorized test environment; UI fixtures never establish runtime
truth. Preserve regression coverage for data states, routing, dirty guards,
account control, keyboard tabs, focus return and copy races. Do not weaken a valid
behavioral test to accommodate the visual contract.

| Verification dimension | Required evidence                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route coverage         | All 14 canonical hashes, legacy normalization and Back/Forward; Settings and retained compositions separately                                                              |
| Viewport               | Wide 1920×1080, desktop 1440px, intermediate 1024px, phone 390px; a 320px reflow check and 200% zoom                                                                       |
| Appearance             | EN and NL; light, dark and system; representative forced-colors checks                                                                                                     |
| Inputs                 | Pointer, keyboard Tab/Shift+Tab/Enter/Space/Arrow/Home/End/Escape, touch-size checks, nested popup and focus return                                                        |
| Motion                 | Normal and reduced motion, rapid selection, insert/remove, failed copy, pending and idle; every animation settles                                                          |
| Behavior               | At least each route's primary workflow, first failure, applicable empty state, last-good refresh failure and recovery; safe write validation/confirmation where applicable |
| Interpretation         | Configured versus observed, unknown versus zero, saved versus applied, masked identity and scoped evidence remain distinguishable                                          |

Run the existing isolated GUI test script (`cd gui && bun run test`), GUI lint
and build for functional GUI work; run `lint:i18n` for copy/locale changes. Root
`bun run typecheck` and `bun run test` remain required for nontrivial changes;
privacy and other applicable repository gates remain intact. No new tests are
needed to mirror this documentation rewrite. Record actual check results on the
commit being assessed; screenshots and a build do not certify all workflows.
User-facing behavior changes later also require public-doc/localization sync.

The remaining design judgments are the optical spacing/column/collapse choices
and landing assessment listed in DESIGN. They do not leave runtime semantics,
route ownership, security, keyboard behavior or the surface/motion policy open.
Final visual acceptance remains unobserved in Phase 1. Stop after its local
commit; no push, merge, deployment or Phase 2 implementation is included.
