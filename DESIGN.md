# FROST Guard Design System

## 1. Atmosphere & Identity

FROST Guard is a quiet, technical safety control: calm during normal browsing, precise when intervention is required, and explicit before destructive actions. Its signature is restrained status color on cool neutral surfaces, with warning emphasis reserved for verified risk and user-requested recovery.

## 2. Color

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Page surface | `--surface-page` | `#f3f6fa` | Popup and options backgrounds |
| Panel surface | `--surface-panel` | `#ffffff` | Cards, controls, dialogs |
| Soft surface | `--surface-soft` | `#f4f7fa` | Metrics and grouped metadata |
| Input unit surface | `--surface-unit` | `#f2f5f8` | Unit suffixes and compact controls |
| Safe surface | `--surface-safe` | `#f0faf7` | Enabled protection hero |
| Warning surface | `--surface-warning` | `#fffbef` | Advisory cards and notices |
| Danger surface | `--surface-danger` | `#fff0ed` | Blocked-event pills |
| Pill surface | `--surface-pill` | `#edf3f8` | Neutral event pills |
| Text primary | `--text-primary` | `#162238` | Headings and body copy |
| Text secondary | `--text-secondary` | `#607084` | Supporting copy |
| Text muted | `--text-muted` | `#526074` | Form labels and compact lists |
| Border | `--border-default` | `#dbe2eb` | Card boundaries |
| Subtle border | `--border-subtle` | `#e5e9ef` | Dividers and table rows |
| Input border | `--border-input` | `#7b899b` | Form-control boundaries with 3:1 non-text contrast |
| Button border | `--border-button` | `#7b899b` | Secondary button boundaries with 3:1 non-text contrast |
| Danger border | `--border-danger` | `#8f2929` | Destructive controls and dialogs with 3:1 non-text contrast |
| Warning border | `--border-warning` | `#e4c487` | Advisory boundaries |
| Safe border | `--border-safe` | `#afd1c5` | Enabled protection hero |
| Accent | `--accent-primary` | `#1d5f92` | Primary actions and links |
| Accent hover | `--accent-hover` | `#154d78` | Primary-action hover state |
| Focus | `--focus-ring` | `#0b65c2` | Keyboard focus |
| Safe | `--status-safe` | `#197153` | Protected and successful states |
| Warning | `--status-warning` | `#7a5211` | Suspicious but non-emergency states |
| Danger | `--status-danger` | `#8f2929` | Destructive actions and errors |
| Unchecked control | `--control-track` | `#7b899b` | Enabled unchecked switch track |

The isolated in-page notice mirrors these semantic roles with shadow-scoped aliases: surface `#fff7ed`, text `#3f1d0b`, action `#9a3412`, action hover/button text `#7c2d12`, button surface `#ffffff`, button hover `#ffedd5`, border `rgba(127, 29, 29, 0.45)`, focus `#0b65c2`, and shadow `rgba(0, 0, 0, 0.28)`.

Status colors communicate state only. Routine blocking uses the in-page surface and badge; operating-system notifications are reserved for monitor-confirmed storage growth.

## 3. Typography

The primary stack is `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`; identifiers use the browser monospace stack. Popup body copy is at least `12px`; options body copy is at least `14px`. Headings use compact `15px` to `19px` sizes with `600` to `750` weight. Numeric metrics use tabular figures.

## 4. Spacing & Layout

Spacing follows a 4px base with 8px, 12px, 16px, 20px, and 24px steps. Popup width is 370px with a 16px shell. Options content is fluid up to 1180px, uses a primary-plus-aside grid above 900px, and becomes a single readable column below that breakpoint. No primary content requires horizontal page scrolling at 375px.

## 5. Components

### Status card
- **Structure**: status indicator, heading, origin, concise detail.
- **States**: loading, protected, allowed, unsupported, disabled.
- **Accessibility**: state is exposed as text; only concise action feedback uses a polite live region.
- **Motion**: none.

### Buttons and switches
- **Variants**: primary, secondary, danger, text link, checkbox switch.
- **States**: default, hover, active, focus-visible, disabled, busy.
- **Accessibility**: visible labels, 2px focus ring, destructive actions require a persistent dialog confirmation.
- **Motion**: 120ms transform/color feedback; disabled under reduced-motion preference.

### In-page notice
- **Structure**: title/meta, concise explanation, event count, open-log action, one dismiss action.
- **States**: first event, updated/coalesced event, monitor-confirmed growth.
- **Accessibility**: `role="status"`, polite live updates, no assertive interruption for routine blocks.
- **Motion**: none.

### Build provenance disclosure
- **Structure**: native `details` disclosure populated from packaged `manifest.json` and `package.json`.
- **States**: loading, loaded, unavailable.
- **Accessibility**: native keyboard interaction; external references are descriptive links.
- **Motion**: none.

### Confirmation dialog
- **Structure**: native `dialog`, specific consequence text, cancel and explicit destructive action.
- **States**: closed, open, busy, error returned to the originating polite status region.
- **Accessibility**: focus enters the dialog, Escape cancels, labels name the affected data.
- **Motion**: none.

## 6. Motion & Interaction

Motion only confirms direct interaction. Switch thumbs and button presses use transform or color transitions no longer than 120ms. `prefers-reduced-motion: reduce` disables transitions. No entrance, decorative, or attention-seeking animation is used.

## 7. Depth & Surface

Use a mixed strategy: subtle cool borders define controls and panels; shallow shadows separate extension-owned surfaces from pages. Warning surfaces use warm tonal shifts rather than stronger shadows. The in-page notice is visually distinct but compact and dismissible.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA contrast target.
- Full keyboard reachability and visible `:focus-visible` treatment.
- Polite live regions for asynchronous updates; no duplicate live announcements.
- Destructive consequences are stated before confirmation.
- Long origins and metadata wrap without forcing page-level horizontal scrolling.

### Accepted Debt

None. The closed shadow root remains intentional isolation from host-page CSS; its controls and live-region semantics must be verified in Chromium.
