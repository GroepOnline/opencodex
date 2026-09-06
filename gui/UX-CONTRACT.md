# OCX workspace UX contract

Scope: the pending workspace navigation, Overview and Settings migration. This
records ownership, not approval of the unfinished visual redesign. Existing
provider/authentication, deletion, billing and persistence policy stays with its
runtime owner; this document does not invent replacement business rules.

## Product and authority

- Audience: operators routing model clients through the existing OCX proxy.
- Jobs: inspect real runtime/provider readings, navigate configuration, adjust
  language and theme without changing provider credentials.
- Domain: repository `CONTEXT.md`; management API: `src/api.ts` in this GUI;
  route catalogue and health state: `src/App.tsx`.
- EN/NL copy and locale persistence: `src/i18n/`; no new markets, timezone policy
  or provider-family claims in this migration.
- Visual authority: `DESIGN.md`; runtime CSS remains canonical. The Tailwind
  adapter maps existing roles, never a second palette or reset.
- Accessibility target: WCAG 2.2 AA. Automated/component checks and bounded Brave
  checks are evidence for specific behaviors, not a conformance certification.

## Canonical UI Map

| Capability             | Canonical owner               | Source of truth                                          | Allowed variants                                                               | Verification                                                 |
| ---------------------- | ----------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Select/Listbox         | Shared Select                 | `src/ui.tsx`, `src/select-position.ts`                   | Authored, portaled by default; inline inside Settings Sheet                    | Existing select tests; nested Escape and popup browser check |
| Settings overlay       | Shared Sheet / Base UI Dialog | `src/components/primitives/sheet.tsx`                    | Controlled modal; translated title/close; external return-focus ref            | `tests/settings-sheet.test.tsx`, native Tab/Shift+Tab/Escape |
| Theme selection        | Shared ToggleGroup            | `src/components/primitives/toggle-group.tsx`             | Light/dark/system, exactly one active value                                    | Settings behavioral tests                                    |
| Buttons / empty states | Shared Button / Empty         | `src/components/primitives/button.tsx`, `empty.tsx`      | Existing `.btn` callers remain legacy; touched Overview uses shared primitives | Overview data-state tests and browser                        |
| Readings               | MetricList                    | `src/components/MetricList.tsx`                          | Semantic definition list, numbers supplied by caller                           | Dashboard data-state tests                                   |
| Scrollbar              | Application stylesheet        | `src/styles/workspace-orbit.css`                         | Global semantic roles; forced-colors defers to system                          | Computed styles / browser; platform rendering may differ     |
| Navigation             | WorkspaceNavigation           | `src/components/WorkspaceNavigation.tsx`, `src/route.ts` | Existing hashes; current page via aria-current                                 | Workspace navigation tests                                   |

There is no new table selection, form submission, date input, toast or CRUD owner
in this slice. Existing workflows retain their owners pending explicit migration.

## Behavior and resilience

- Dashboard: pending is not empty; successful zero stays zero; unsuccessful first
  load displays unknown readings. Failed refresh preserves fetched readings and
  shows the error in the affected section. Polling remains owned by Dashboard.
- Empty-success providers/traffic has a real link to the relevant configuration
  or traffic route. A failure never simultaneously claims successful emptiness.
- Settings: title labels the dialog; opening focuses Close, Tab wraps inside,
  closing restores the external opener. Escape first dismisses an open Select,
  then the Sheet. The locale popup stays inside the dialog and matches its trigger.
- Language/theme selections reuse current persistence. Removed skin choices were
  visually identical under the new token override; saved values are not deleted.
- Buttons retain native disabled behavior and visible focus. Icon-only Close has
  localized accessible copy. No decorative pressed translation or transition-all.
- Overlay uses existing `--z-modal`; the inline locale popup uses `--z-popover`
  inside it. No unrelated body-level popup may escape modal focus containment.

## Navigation, layout and motion

- Document title is localized route name plus opencodex; public landing keeps the
  product name. Single-destination views do not repeat an Overview subtab.
- Desktop side rail becomes six labelled mobile destinations in two rows. Primary
  navigation and Settings controls keep 44px targets; no page-wide overflow.
- Mobile readings become compact label/value rows rather than empty KPI cards.
- Pointer selection has a scoped, interruptible shared-layout spring; keyboard
  navigation and reduced motion are instant. No page entrance animation.
- Settings movement is at most 200ms, transform/opacity only. Keyboard opening is
  instant; reduced motion suppresses displacement. No ambient animation added.

## Migration and verification

- Source owners above precede premium defaults. This is incremental migration,
  not permission to replace established controls with screen-local copies.
- Legacy provider textareas remain vertically resizable. A stricter premium
  resize-none migration requires usable autosizing/expansion, not lost editing
  capacity. The static audit reports this debt; it is not suppressed.
- Run `bun run test` (existing isolated GUI script), `bun run lint`,
  `bun run lint:i18n`, `bun run build`; root checks and docs build per AGENTS.
- Behavioral evidence: `tests/dashboard-data-states.test.tsx`,
  `tests/settings-sheet.test.tsx`, `tests/workspace-navigation.test.tsx`.
- Browser matrix: desktop 1440, intermediate 1024, mobile 390; EN/NL, light/dark,
  reduced motion, focus return and nested popup. Any unobserved combination remains
  unverified. Synthetic UI fixtures are explicitly not live runtime evidence.
- Full provider CRUD, screen-reader audit, all detail panels, public landing,
  exact-head CI/security approval and deployment acceptance remain separate gates.
- Rollout is through the existing OCX PR/release path. No production cutover is
  authorized by a local preview or static audit alone.
