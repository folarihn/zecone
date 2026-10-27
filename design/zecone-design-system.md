# ZecOne design system

One brand for ZecOne Wallet and ZecOne Pay. Source of truth: the `@theme` block in `app/globals.css` and the components in `app/ui.tsx` and `app/components/ui-client.tsx`.

## Idea

**Shielded ledger.** Warm ivory pages carry the public, readable parts of the product. Deep forest bands carry the private parts: the hero, the mainnet evidence, the footer, code. Chartreuse is a signal, used for the one action that matters on a surface and for "you are here". Gold always means Zcash; blue always means Base. A quiet diagonal hatch appears only where data is encrypted.

## Colour

| Token | Hex | Use |
| --- | --- | --- |
| `forest` / `ink` | `#102820` | Primary text, dark bands, primary buttons |
| `forest-2` | `#18382c` | Raised surface on forest |
| `navy` | `#1d3d31` | Hover for forest buttons |
| `lime` | `#d7f276` | Primary action on dark, active states, focus ring. Never body text on ivory |
| `lime-deep` | `#4c620f` | Chartreuse family as text on ivory (6.1:1) |
| `ivory` / `canvas` | `#f6f5ed` | Page |
| `paper` / `surface` | `#fdfcf7` | Cards, panels |
| `sage` | `#758a80` | Decorative only (icons, rules); too light for body text |
| `muted` | `#52675d` | Secondary text (sage refined to 5.6:1 on ivory) |
| `ink-soft` | `#2f463c` | Long-form body text |
| `line` / `line-strong` | `#e2e1d3` / `#c9ccbb` | Borders |
| `gold` / `gold-deep` / `gold-soft` | `#e8b547` / `#83600d` / `#f6ebcb` | Zcash, shielded, warnings |
| `blue` / `blue-deep` / `blue-soft` | `#2a56c6` / `#1f4199` / `#e5ebf6` | Base, public |
| `green`, `red`, `amber` (+ `-soft`) | `#22704a`, `#ad3426`, `#93600c` | Status only |

Refinements from the starting palette: sage was darkened to `#52675d` for text; a readable `lime-deep` and `gold-deep` were added because chartreuse and gold fail contrast as text on ivory.

## Type

Bundled locally in `app/fonts` (SIL OFL), loaded with `next/font/local`, exposed as CSS variables with system fallbacks.

| Role | Family | Size / line / tracking | Class |
| --- | --- | --- | --- |
| Display headline | Space Grotesk 600 | clamp(2.6rem to 4.6rem) / 0.98 / -0.035em | `zc-display` |
| Page title | Space Grotesk 600 | clamp(2.1rem to 3.1rem) / 1.04 / -0.03em | `zc-title` |
| Section heading | Space Grotesk 600 | clamp(1.65rem to 2.25rem) / 1.1 / -0.025em | `zc-h2` |
| Card / sub heading | Space Grotesk 600 | 1.25rem / 1.25 | `zc-h3` |
| Lead | Manrope | 18px / 1.6 | `zc-lead` |
| Body | Manrope | 16px / 1.6 (docs 16.5 / 1.7) | default |
| Caption | Manrope | 13 to 14px / 1.5, never below 12.5px | `zc-caption` |
| Button | Manrope 600 | 14 / 15 / 16px by size | `buttonClass()` |
| Form label | Manrope 600 | 14px | `Field` |
| Transaction hash | IBM Plex Mono 400 | 13px, wraps or truncates with title | `Hash`, `zc-hash` |
| Code block | IBM Plex Mono | 13.5px / 1.7 on forest | `CodeBlock` |

Rules: sentence case everywhere, no all-caps labels, no accent word in headlines, no em dashes in copy.

## Components

`app/ui.tsx` (server-safe): `Container`, `Band` (ivory, paper, forest), `Logo`, `Wordmark`, `ZcashMark`, `BaseMark`, `Eyebrow`, `SectionHeading`, `Breadcrumbs`, `PageHeader`, `ButtonLink` and `buttonClass()` (primary, secondary, ghost, lime, outline-dark; sm, md, lg), `Card`, `Panel`, `Pill`, `StateBadge` (every payment state), `ModeBadge` (simulated demo, mainnet monitoring, live), `Callout` (info, warning, danger, success), `EmptyState`, `Spinner`, `Skeleton`, `Field` and `inputClass`, `Hash`, `TxRow`, `DataList`.

`app/components/ui-client.tsx`: `CopyButton`, `Tabs` (roving focus, arrow keys), `Dialog` (native `<dialog>`, focus trapped, Esc closes), `ToastProvider` / `useToast`.

Other: `app/nav.tsx` (primary nav with menus and mobile drawer), `app/docs/code-block.tsx` (labelled, highlighted, copyable), `app/docs/docs-nav.tsx` (grouped sidebar, filter, scroll spy), `app/components/hero-lane.tsx` (hero diagram).

## Modes

The three operating modes always look the same: **Simulated demo** neutral with a dashed edge, **Mainnet monitoring** gold, **Live settlement** green. The checkout component (`@zecone/sdk/react`) opens with a mode strip so a customer never mistakes a demo for a real payment, and demo checkouts never render an address, QR code or `zcash:` link.

## Motion

One orchestrated moment: the hero lane, where a dot travels from Zcash through the shielded pool (dimming while encrypted) to Base. Everything else is response motion (menus, dialogs, toasts). All of it stops under `prefers-reduced-motion`. No animation library.

## Accessibility

Visible focus ring on every control (forest on ivory, chartreuse on forest), skip link, 44px minimum touch targets for primary controls, labelled inputs, `aria-current` on navigation, status messages in live regions, contrast at AA or better for all text tokens.

## Wallet isolation

All public-site typography sits on the `.zc-site` wrapper. `.wallet-scope` rules were not changed, and the `/wallet` page content is rendered outside `.zc-site` so nothing leaks into the wallet.
