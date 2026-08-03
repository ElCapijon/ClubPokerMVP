# 🃏 Poker Club — UI & Mobile Spacing Guide

Everything you need to know about the frontend UI, with a heavy focus on **mobile spacing** (the part that's easy to break and hard to reason about).

> **TL;DR — the 30-second version**
> The whole game screen is a **flex column with zero scrolling**: header (fixed) → table (absorbs all leftover space) → action bar (never shrinks). On mobile the screen height is measured with `svh` (not `vh`) so the browser's address bar can't push your buttons off-screen. The felt table is **height-driven**: it takes `height: 100%` of its row and derives its width from an `aspect-ratio`, so it *always* fits. All mobile compaction lives in **one place**: `frontend/src/mobile-overrides.css` — imported after `index.css` in `main.jsx` — using `!important` overrides.

---

## 1. Tech stack & how the app is built

| Thing | Choice |
|---|---|
| Framework | React 18 (function components + hooks) |
| Build | Vite 5 (`npm run dev` in `frontend/`) |
| Styling | Tailwind CSS 3.4 + `frontend/src/index.css` (base, components, animations) + `frontend/src/mobile-overrides.css` (ALL responsive overrides) |
| Realtime | socket.io-client |
| Fonts | Inter (body), Playfair Display (`font-display`), JetBrains Mono (`font-mono`) — loaded from Google Fonts in `frontend/index.html` |
| Palette | Custom Tailwind colors in `frontend/tailwind.config.js` (see §9) |

There is **no component library** and **no CSS-in-JS**. Tailwind classes are applied inline in JSX, and every piece of mobile-specific compaction is done with plain CSS media queries in **`frontend/src/mobile-overrides.css`**. **This split is the single most important thing to understand:** Tailwind utilities give you the *desktop default*; `mobile-overrides.css` (imported *after* `index.css` in `main.jsx`) overrides it on phones with `!important`.

---

## 2. File map — what lives where

```
frontend/
├── index.html              ← viewport meta (user-scalable=no), fonts, title
├── vite.config.js          ← dev server + /api & /socket.io proxy to :3000
├── tailwind.config.js      ← theme: colors, fonts, animations
├── postcss.config.js       ← tailwind + autoprefixer
└── src/
    ├── main.jsx            ← entry point; imports index.css THEN mobile-overrides.css
    ├── index.css           ← Tailwind entry: base, component classes, animations, scrollbar
    ├── mobile-overrides.css ← ★ ALL mobile media queries + --card-* size variables
    ├── App.jsx             ← view router: auth → lobby → club room (+ reconnecting)
    ├── Lobby.jsx           ← stake-level grid + buy-in modal
    ├── ClubRoom.jsx        ← ★ the game table — the big one (all layout lives here)
    ├── ProgressPanel.jsx   ← floating quests button + bottom-sheet panel
    ├── socket.js           ← socket.io connection helpers
    └── auth.js             ← token / user persistence
```

**Where to look first when spacing breaks:**

- Layout structure of the table screen → `ClubRoom.jsx`, the `RENDER` section (search for `landscape-row`).
- Every mobile spacing override → `frontend/src/mobile-overrides.css` (the whole file is mobile-only).
- Card sizes → `CARD_DIMENSIONS` at the top of `ClubRoom.jsx` (desktop defaults) **plus** the `--card-*` CSS variables in `mobile-overrides.css` (mobile). CSS wins on phones.

---

## 3. Screen / view flow

```
auth (login/signup/reset)  ──▶  lobby  ──▶  club room (game table)
                                  ▲            │
                                  └────────────┘ (cash out / leave)
```

- **Auth + Reconnecting + Lobby** screens are simple centered layouts using `min-h-screen-mobile` — they don't need the fancy fit logic.
- **Club room** is the screen with the brutal mobile constraints (table + 6 seats + cards + buttons all on one screen).
- **ProgressPanel** floats above *both* lobby and club room as a fixed overlay (bottom-right FAB → bottom sheet).

---

## 4. The layout model (the heart of everything)

### 4.1 The three-zone flex column

Every full-screen page root is:

```jsx
<div className="min-h-screen-mobile bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex flex-col overflow-hidden">
```

Inside the **club room**, the body is split into **two zones** (there is no header bar — the old one was removed so the table gets the full screen height):

```
┌─────────────────────────────────────┐
│  (Leave)  ← floating top-left       │  ← Leave + Cash Out are absolute
│  (Cash Out) floating top-right      │    overlays on the root (which is `relative`)
│  TABLE ZONE  (flex-1 min-h-0)       │  ← absorbs ALL leftover space
│  ┌───────────────────────────────┐  │
│  │ felt-wrap (height:100%)       │  │
│  │ aspect-ratio decides shape    │  │
│  └───────────────────────────────┘  │
│                                     │
├─────────────────────────────────────┤
│ action bar (shrink-0, never grows)  │  ← Fold/Check/Call + bet slider (your hole
└─────────────────────────────────────┘    cards live on the felt at your seat — §7)
```

```jsx
<div className="flex-1 flex flex-col min-h-0 landscape-row">      <!-- zone wrapper -->
  <div className="flex-1 flex items-center justify-center p-0.5 sm:p-2 min-h-0 landscape-table">
    <div className="relative w-full max-h-full sm:aspect-[4/3] aspect-[2/1] felt-wrap"
         style={{ maxWidth: '800px', maxHeight: '100%' }}>
      <div className="felt-table w-full h-full ...">…community cards, pot, street…</div>
      {players.map(...)}  <!-- seats + bet chips, absolutely positioned by % -->
    </div>
  </div>
  <div className="shrink-0 ... landscape-controls">…your cards + buttons…</div>
</div>
```

**The rule that makes it work:** the *controls bar is `shrink-0`* (it can never be squeezed or scrolled — the buttons are always visible and tappable), and the *table zone is `flex-1 min-h-0`* (it absorbs every pixel of leftover space, and its felt shrinks to fit). If you ever make the table `shrink-0` or remove `min-h-0`, the buttons get pushed off-screen.

### 4.2 Viewport height: `svh`, not `vh` (THE mobile fix)

Mobile browser chrome (address bar, bottom nav) means `100vh` is *taller than the visible screen*. The app solves this once, globally, with two helper classes defined in `mobile-overrides.css`:

```css
@supports (height: 100svh) {
  .min-h-screen-mobile { min-height: 100svh !important; }
  .h-screen-mobile     { height: 100svh !important; }
}
@supports not (height: 100svh) {
  .min-h-screen-mobile { min-height: 100vh !important; }
  .h-screen-mobile     { height: 100vh !important; }
}
```

- **`svh`** = small viewport height = the area that's *always* visible even with the browser UI expanded.
- **Use `h-screen-mobile` (definite height) on the club room** — the game screen must have a *definite* height or the felt's `height: 100%` chain silently fails to resolve (a `min-height` container is auto-height). **Use `min-h-screen-mobile` on the scrolling screens** (auth, lobby, reconnecting).
- Never use plain `vh`/`h-screen` — they reintroduce the iOS address-bar bug instantly.
- If a page scrolls or clips the bottom on a phone, check for a plain `vh`/`h-screen` — or a `min-height` root on a screen that needs a definite height.

### 4.3 The felt table: shape driven by `aspect-ratio` + `height:100%`

The table is a **racetrack / stadium shape** (`border-radius: 9999px` makes the ends semicircular; a thick wood-colored border `12px solid #4a2c0a` is the rail). What changes between orientations is the **aspect ratio** of `felt-wrap`, and the felt always fills 100% of it:

| Context | Effective `aspect-ratio` | Shape |
|---|---|---|
| Desktop (≥ 640px) | `4 / 3` (Tailwind `sm:aspect-[4/3]`) | horizontal oval |
| **Mobile portrait** (`orientation:portrait`, ≤ 639px) | `4 / 5` — **vertical stadium**, stands tall | vertical oval |
| **Mobile landscape** (`orientation:landscape`, ≤ 700px height) | `2 / 1` — flat oval | flat oval |

The **base** classes are also height-driven — `h-full max-w-full` (NOT `w-full max-h-full`, which would be width-driven and clamp the height on short screens):

```jsx
// ClubRoom.jsx — the felt is height-driven in EVERY context
<div className="relative h-full max-w-full sm:aspect-[4/3] aspect-[2/1] felt-wrap"
     style={{ maxWidth: '800px', maxHeight: '100%' }}>
```

The mobile blocks below only change the **ratio** (they override the base with `width: auto; height: 100%; max-width: 100%; aspect-ratio: …` — all `!important`):

```css
/* mobile-overrides.css — portrait phones */
@media (orientation: portrait) and (max-width: 639px) {
  .felt-wrap {
    width: auto !important;      /* width derived from height */
    height: 100% !important;     /* height-driven! */
    max-width: 100% !important;
    aspect-ratio: 4 / 5 !important;
  }
}
/* mobile-overrides.css — landscape phones */
@media (orientation: landscape) and (max-height: 700px) {
  .landscape-table .felt-wrap {
    width: auto !important;
    height: 100% !important;
    max-width: 100% !important;
    aspect-ratio: 2 / 1 !important;
  }
}
```

**Why it never overflows:** the felt's height is a percentage of its row (which is `flex-1 min-h-0`, i.e. "whatever is left after the controls"). Width follows from the ratio and is capped at `max-width: 100%` (or the 800px inline cap on desktop). So *regardless of how short the viewport is*, the table shrinks to fit — there is no scroll, ever. Trade-off: on very tall windows the width cap (800px) can be reached before the ratio fills the height, so the felt grows taller instead of staying 4:3 — it never overflows, it just fills.

> ⚠️ When the felt shape changes (4/5 ↔ 2/1 ↔ 4/3), the **seats automatically re-map** because they're positioned in *percentages* of the felt — see §6.

---

## 5. Responsive breakpoints — the master table

There are **four** breakpoint blocks in `frontend/src/mobile-overrides.css` (plus the JS `useIsMobile()` hook). Learn these by heart — every mobile-spacing edit happens inside them.

| # | Breakpoint | CSS selector | Purpose |
|---|---|---|---|
| 1 | `max-width: 640px` | `@media (max-width: 640px)` (mobile-overrides.css) | Touch targets: buttons ≥ 36px, slider thumb 18px |
| 2 | `max-width: 380px` | `@media (max-width: 380px)` (mobile-overrides.css) | Tiny phones: slimmer rail (8px), smallest seat cards (26×38) + community (32×46) |
| 3 | **Portrait phones** | `@media (orientation: portrait) and (max-width: 639px)` (mobile-overrides.css) | Stand the table **vertical** (4/5), hide last-action ticker, compact seat cards (30×44) |
| 4 | **Landscape phones/tablets** | `@media (orientation: landscape) and (max-height: 700px) and (max-width: 1024px)` (mobile-overrides.css) | Compact bottom bar: flat table (2/1), 6px rail, tiny cards, slider hidden. The `max-width: 1024px` keeps short **desktop** windows on the full 4:3 table with the slider |

**And the JS hook** in `ClubRoom.jsx`:

```js
// True below 640px → drives smaller Tailwind card sizes in JSX
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  // ...listens for changes...
}
```

It's used for:
- community cards: `size={isMobile ? 'md' : 'lg'}`
- your seat cards (on the felt): `size={isMobile ? 'sm' : 'md'}`
- the landscape-phone bottom-bar hole cards only: `size={isMobile ? 'lg' : 'xl'}`

A second hook, `useIsLandscapePhone()` (same media query as the landscape CSS
block), decides **where your hole cards render**: on the felt at your seat on
desktop/portrait, or in the compact bottom bar on landscape phones where the
flat 2:1 felt has no room.

> ⚠️ **The 700px landscape threshold is deliberate.** The CSS comment explains: phones whose *layout viewport is taller than the visible area* (due to browser chrome) still get the compact landscape layout instead of the full-size portrait bar displayed sideways. Don't "clean it up" to 500px.

### Why the CSS uses `!important` everywhere

On desktop, Tailwind utilities + inline pixel sizes are correct. The mobile blocks need to *beat* both inline `style={{ width: … }}` on cards and `sm:` prefixed utilities, so every mobile override is marked `!important`. **When you tweak mobile spacing, edit `mobile-overrides.css` — not the Tailwind classes in JSX** (they'd only change desktop).

---

## 6. Card size system (the most overridden thing in the app)

Base sizes come from `CARD_DIMENSIONS` in `ClubRoom.jsx`:

```js
const CARD_DIMENSIONS = {
  xl: { w: 64, h: 90, ... },  // hole cards in the landscape-phone bottom bar
  lg: { w: 50, h: 72, ... },  // community cards (desktop)
  md: { w: 40, h: 56, ... },  // your seat cards (desktop) — then CSS shrinks further
  sm: { w: 32, h: 46, ... },  // seat card backs
};
```

**Effective sizes by context** (CSS `!important` overrides win over the JS sizes):

| Context | Desktop | Mobile portrait | Mobile landscape |
|---|---|---|---|
| Your seat cards (`.hero-seat-cards`, on the felt) | md — 40×56 | **30×44** | *(not on the felt)* |
| Your hole cards (`.landscape-hole-cards`, bottom bar) | *(not in the bar)* | *(not in the bar)* | **36×52** |
| Community cards (`.community-row`) | lg — 50×72 | **38×54** | **32×46** |
| Seat card backs | sm — 32×46 | 32×46 | 32×46 |

**How the mobile sizes are applied** — in `mobile-overrides.css`, one consumer rule per card type, sized by CSS variables that each breakpoint simply redefines (single source of truth per breakpoint):

```css
:root {
  --card-width-hole: 64px;        --card-height-hole: 90px;      /* landscape-phone bottom bar only */
  --card-width-community: 50px;   --card-height-community: 72px;
  --card-width-hero-seat: 40px;   --card-height-hero-seat: 56px; /* your cards on the felt */
}
/* Consumer rules — only exist to beat the inline CARD_DIMENSIONS sizes: */
.landscape-hole-cards .card-front, .landscape-hole-cards .card-back {
  width: var(--card-width-hole) !important;  height: var(--card-height-hole) !important;
}
.community-row .card-front, .community-row .card-back {
  width: var(--card-width-community) !important;  height: var(--card-height-community) !important;
}
.hero-seat-cards .card-front, .hero-seat-cards .card-back {
  width: var(--card-width-hero-seat) !important;  height: var(--card-height-hero-seat) !important;
}
/* Each breakpoint only redefines the variables — no px in selectors anymore: */
@media (orientation: portrait) and (max-width: 639px) {
  :root { --card-width-hole: 44px; --card-height-hole: 64px; }
}
@media (orientation: landscape) and (max-height: 700px) {
  :root { --card-width-hole: 36px; --card-height-hole: 52px;
          --card-width-community: 32px; --card-height-community: 46px; }
}
```

> `.card-front` and `.card-back` are defined in `@layer components` inside `index.css` (the base card look: white gradient face, striped blue back). The rules above target those same classes to **resize** them — the component-layer base styling and the media-query sizing are two separate concerns, and since the overrides live *outside* the layer with `!important`, they always win.

Card fonts also scale down alongside (e.g. `16px` rank in portrait, `15px` in landscape).

> **Spacing rule of thumb:** the cards are the *currency* of mobile space. The vertical budget is roughly `controls ≤ screen height` (there's no header and no hole-card row — Leave/Cash Out float, and **your hole cards live on the felt at your seat**), with the table taking the rest. If you add a new control and the table starts to feel crushed, the lever to pull is **card size** (the seat cards first — see §7 positions), not table size.

---

## 7. Seats & bet chips (percentage positioning)

Seats are **not** flex items — they're absolutely positioned overlays in *percentages of the felt*, which is exactly why they work in every orientation:

```js
// ClubRoom.jsx — positions are % of the felt, clockwise from bottom-center
const SEAT_POSITIONS = [
  { top: 91, left: 50 },  // Seat 0: Hero — bottom center
  { top: 68, left: 10 },  // Seat 1: Lower-left
  { top: 32, left: 10 },  // Seat 2: Upper-left
  { top: 8,  left: 50 },  // Seat 3: Top center
  { top: 32, left: 90 },  // Seat 4: Upper-right
  { top: 68, left: 90 },  // Seat 5: Lower-right
];
```

Bet chips sit on the felt in front of each seat, nudged toward the center via `BET_CHIP_POSITIONS`. The pot is at `{ top: 50, left: 50 }`.

**Your hole cards render on the felt too** — absolutely positioned at `getHeroCardPos(seat, isMobile)` via the per-seat `HERO_CARD_POSITIONS` tables (one for desktop, one for mobile portrait). The pair hugs the **rail beside the seat column** rather than floating up toward the pot (that read as "too high up the table"):
- center seats (0/3): beside the avatar at the rail — bottom-center seat puts the pair to the **right** (left 61% desktop / 63% mobile, top 84% / 86%), top-center to the **left** (39% / 37%, top 16% / 14%);
- side seats (1/2/4/5): below the lower seats (1/5) and above the upper seats (2/4) at the rail (top 84% / 16% desktop, 86% / 14% mobile), nudged toward the table inside of the seat column (left 21% / 79% desktop, 25% / 75% mobile) — clear of the avatar/dealer column, the bet chip, the community cards and the pot pill.

Cards get a slight fan (rotate ±5°) and scale to 110% while it's your turn. On **landscape phones** they fall back to the compact bottom bar (`useIsLandscapePhone()`), because the flat 2:1 felt has no room.

**Do not convert these to pixels.** Because the felt changes shape (4/5 portrait, 2/1 landscape, 4/3 desktop), percentage positions are the only thing that keeps seats on the rail in all three. If seats ever drift off the felt, the felt's aspect ratio changed or a seat got a fixed-pixel offset.

Each seat is `-translate-x-1/2 -translate-y-1/2` positioned at `top%`/`left%`, stacked content: dealer button → avatar (pulsing green when it's the player's turn) → name → stack → status badges.

---

## 8. The action bar (controls) — what's in it & how it stays on screen

Inside `.landscape-controls` (bottom zone), top to bottom:

1. **Last-action ticker** (`.last-action-bar`) — *hidden* on portrait and landscape phones (it costs a full row).
2. **Your hole cards** (`.landscape-hole-cards`) + stack — *only on landscape phones*. Everywhere else your cards render on the felt at your seat (§7) and this row isn't in the DOM.
3. **Controls row** (`.flex flex-wrap … justify-center gap-1.5 sm:gap-2`) containing:
   - Your-turn countdown pill (when it's your turn)
   - Rebuy / Sit Out (when busted)
   - Ready / Start / bots (when WAITING)
   - **Fold / Check / Call** (`.action-btn-*`)
   - **Bet presets** (½ Pot / ¾ Pot / Pot — `.preset-btn`), **bet slider** (`.bet-slider`), **Raise / All-In** buttons

### Mobile compaction applied to the controls (mobile-overrides.css)

| Element | Base | ≤640px | Portrait | Landscape |
|---|---|---|---|---|
| Action buttons | `px-4 py-2 text-xs` | `6px 12px`, 11px, min-h 32px | — | `4px 8px`, 10px, min-h 28px |
| Preset buttons | `px-2 py-1.5`, 9px | `3px 6px`, 9px, min-h 26px | — | `3px 6px`, 9px, min-h 26px |
| Bet slider | `w-20 sm:w-24 h-1.5` | `width: 64px` | — | **`display: none`** |
| Raise / All-In | `px-4 py-2 text-xs` | — | — | `4px 10px`, 10px, min-h 28px |
| Last-action bar | visible | — | **hidden** | **hidden** |

> **Why the slider is hidden in landscape but presets/Raise stay:** history — hiding the *whole container* also hid Raise/All-In and players couldn't bet sideways. Only the range slider is `display: none` in landscape; `½ Pot / ¾ Pot / Pot` presets + `Raise` + `All-In` remain. **Don't re-add the slider in landscape.**

### Touch targets (≤ 640px)

- Action buttons & preset buttons: `min-height: 36px` (raised from the base).
- Slider thumb: 14px → **18px** on mobile.

### Hook classes (no base styling of their own)

`.landscape-row`, `.landscape-table`, `.landscape-controls`, `.landscape-hole-cards`, `.last-action-bar`, `.community-row` and `.pot-street-row` carry **no base CSS** in `index.css` — they're class hooks. Their base look comes from Tailwind utilities on the element in JSX (e.g. `shrink-0 bg-gray-900/95 … px-1.5 sm:px-4 py-1 sm:py-3 landscape-controls`), and `mobile-overrides.css` adds properties to them only inside media queries. **If you search `index.css` for `.landscape-controls` and find nothing, that's expected** — check the JSX for the Tailwind styling and `mobile-overrides.css` for the media-query overrides.

---

## 9. Overlays (notifications, modals, progress panel)

All overlays are `fixed` and use the same patterns. **Mobile vs desktop differences are all `sm:` prefixed:**

| Overlay | Mobile | Desktop (`sm:`) |
|---|---|---|
| Notifications | `fixed top-4 left-1/2 -translate-x-1/2 w-full max-w-sm px-4` (z-50) | same |
| Challenge toast (ProgressPanel) | same pattern, **z-[60]** | same |
| Join modal (Lobby) | centered `p-4 bg-black/60 backdrop-blur-sm`, card `max-w-sm p-6` | same |
| Cash Out modal | centered, card `max-w-xs` | same |
| Hand-result overlay | centered `max-w-sm mx-4 p-4`, z-40, `pointer-events-none` | `p-6` |
| **ProgressPanel** | **bottom sheet**: `items-end`, `w-full`, `max-h-[80vh]`, `rounded-t-2xl border-t` | centered dialog: `items-center`, `sm:max-w-lg`, `max-h-[70vh]`, `rounded-2xl border` |

The ProgressPanel pattern in one glance (`ProgressPanel.jsx`):

```jsx
<button className="fixed bottom-4 right-4 z-50 … rounded-full">  {done}/{total}  </button>
<div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center pointer-events-none">
  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto" />  {/* backdrop */}
  <div className="relative pointer-events-auto w-full sm:max-w-lg max-h-[80vh] sm:max-h-[70vh]
                  rounded-t-2xl sm:rounded-2xl border-t sm:border … animate-slide-up">
    …tabs + scrollable content (flex-1 overflow-y-auto)…
  </div>
</div>
```

Note the bottom sheet scrolls *internally* (`flex-1 overflow-y-auto` on content) — that's fine, the sheet itself is bounded by `max-h-[80vh]`.

---

## 10. Mobile spacing — the golden rules

When you change the UI on mobile, keep these in order of importance:

1. **Never scroll the game screen.** Root = **`h-screen-mobile`** (definite `height: 100svh` — a `min-height` root would make the felt's `height: 100%` fail to resolve and collapse) + `flex flex-col overflow-hidden relative` (the `relative` anchors the floating Leave / Cash Out overlays). If content overflows, shrink something (usually cards), don't add scroll.
2. **Use `svh` helpers, never `vh`.** `h-screen-mobile` on the game screen (definite height so `height: 100%` resolves down the chain); `min-h-screen-mobile` on scrolling screens (auth/lobby). A raw `h-screen` reintroduces the iOS address-bar bug instantly.
3. **Controls bar: `shrink-0` and never `overflow: auto`.** The buttons must always be fully visible. The table zone (`flex-1 min-h-0`) is the shock absorber.
4. **`min-h-0` on any flex child that must shrink.** `flex-1` alone does NOT allow a child to shrink below its content — forgetting `min-h-0` pushes the controls off-screen. (Both the zone wrapper and the table row have it. Keep it.)
5. **The felt is height-driven.** Keep `height: 100%` + `aspect-ratio` + `max-width: 100%` on `.felt-wrap`. Never set a fixed pixel height on the table.
6. **Edit mobile sizes in `mobile-overrides.css`, not in JSX.** The `!important` media blocks beat Tailwind utilities and inline card sizes. `CARD_DIMENSIONS` only controls desktop defaults; on phones, card sizes come from the `--card-*` variables — change those, not the JS.
7. **Watch the vertical budget.** Screen height ≈ (table) + controls — there is no header and no hole-card row anymore (Leave/Cash Out float, your cards are on the felt). Adding a row to the controls (e.g. a new button that wraps) *directly steals table height*. Prefer one-line layouts (`flex-wrap`, smaller gaps, `gap-1.5` mobile / `gap-2` desktop).
8. **Keep touch targets ≥ 32px** (36px is enforced at ≤640px for main buttons — don't shrink them back).
9. **Test both orientations.** Portrait flips the table to a tall 4/5 stadium; landscape to a flat 2/1 oval with a hidden slider and ticker. What fits in one will overflow in the other.
10. **Seats are percentages.** Never reposition seats in px.

### The "add a new control" workflow

1. Add it to the controls row in `ClubRoom.jsx` with **desktop** Tailwind classes.
2. Open DevTools → device toolbar → iPhone viewport (portrait *and* landscape).
3. If it wraps to a second line or pushes the table too small, compact it in the matching block of `mobile-overrides.css`:
   - portrait → `@media (orientation: portrait) and (max-width: 639px)`
   - landscape → `@media (orientation: landscape) and (max-height: 700px)`
4. Never add a third visible row to the controls without shrinking the seat cards or the felt content instead.

---

## 11. Debugging & testing mobile layout

- **DevTools device toolbar** (Chrome: `Ctrl+Shift+M`): pick iPhone 12/13/14 in portrait and landscape. Watch for:
  - horizontal/vertical scrollbars appearing on the game screen (should be impossible — check `overflow-hidden` on the root and `min-h-0` on flex children),
  - the action buttons being cut off at the bottom (the controls bar lost its `shrink-0` or the root uses `vh`),
  - seats sitting off the rail (felt ratio changed or a px-based seat offset sneaked in).
- **Emulate `svh` behavior:** toggle "Show address bar" / use a browser tab without the DevTools bar to approximate the short viewport. The layout must hold with the browser UI collapsed.
- **Run it:** `cd frontend && npm run dev` → http://localhost:5173 (proxies API + sockets to `localhost:3000`).
- **Viewport meta** is already set in `index.html` (`width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no`) — zoom is intentionally locked; don't remove it.
- **`theme-color`** is `#0f4d2a` (felt dark) so the browser chrome matches the app.

---

## 12. Common pitfalls (things that have bitten this codebase before)

1. **Using `h-screen`/`100vh` anywhere** → iOS Safari clips the bottom (the action bar disappears under the browser UI). Always `min-h-screen-mobile`.
2. **Editing card sizes in `CARD_DIMENSIONS` to fix mobile** → has zero effect on phones because CSS `!important` overrides it. Edit the `--card-*` variables in `mobile-overrides.css`.
3. **Removing `min-h-0`** from the table row or zone wrapper → controls get pushed off-screen.
4. **Making the table `shrink-0`** (e.g. to "protect" table size) → controls overflow; the table is *supposed* to absorb.
5. **Re-adding the bet slider in landscape** → it's hidden for a reason (keep presets + Raise + All-In instead).
6. **Re-adding the last-action ticker on portrait** → it was removed to give the table more height.
7. **Hardcoding seat/bet-chip coordinates in px** → seats detach from the rail when the felt flips orientation.
8. **Changing the landscape threshold from 700px** → tall-layout phones with browser chrome fall back to the portrait-style bar sideways (broken).
9. **Adding a control that wraps to a new row** → eats the vertical budget; the table shrinks and community cards can collide with side seats. Compensate elsewhere (smaller gap, smaller card, `whitespace-nowrap`).
10. **Forgetting `!important` in a new mobile override** → silently loses to Tailwind utilities / inline styles. **And forgetting the import:** `mobile-overrides.css` is imported in `main.jsx` *after* `index.css` — if that import is ever removed or reordered, every phone layout breaks at once.
11. **Re-adding a header bar to the club room** → eats the vertical budget the table now enjoys. If you need table info back, put it in a small pill on the felt (like the pot/street pills), not a full-width header row. The floating Leave (top-left) and Cash Out (top-right) buttons are `absolute` overlays — keep them that way.

---

## 13. Design tokens (Tailwind theme)

```js
// tailwind.config.js
colors: {
  felt:   { DEFAULT: '#1a6b3c', dark: '#0f4d2a', light: '#2a8f50' },
  poker:  { red: '#c0392b', gold: '#f1c40f', black: '#2c3e50', chip: '#e74c3c' },
}
fontFamily: { display: ['"Playfair Display"', 'Georgia', 'serif'],
              mono:   ['"JetBrains Mono"', 'monospace'] }
```

Global component classes (in `index.css` `@layer components`): `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.input-field`, `.card-front`, `.card-back`, `.poker-chip`, `.seat-empty`, `.seat-occupied`, `.felt-table`, `.action-btn-fold/check/call`, `.preset-btn`, `.bet-slider`. Reuse these instead of hand-rolling new button styles.

All animations live in `index.css`:

- `.animate-card-dealt`, `.animate-card-back-deal` — cards dealing in
- `.animate-fade-in`, `.animate-slide-up`, `.animate-slide-down` — overlays, panels, toasts (the ProgressPanel sheet and all modals use `animate-slide-up`)
- `.animate-chip-stack`, `.animate-pot-grow`, `.animate-chip-fly` — betting feedback
- `.animate-bounce-subtle` — dealer button
- `.animate-pulse-turn` — active-player glow (the primary "your move" signal — keep it prominent)
- `.animate-pulse`, `.animate-spin` — generic

---

## 14. Recent design intent (why it looks like this)

From the git history, the table evolved through these deliberate decisions — respect them when editing:

1. **Racetrack (stadium) shape** replaces the old rectangle — straight sides with rounded caps (`border-radius: 9999px`).
2. **Portrait mode stands the table vertical** (4/5 stadium) so the tall phone screen is used fully, with community cards 'md'-sized and controls compacted so *table + controls* all fit (the header was removed — see below).
3. **Landscape keeps the vertical stack** (table on top, full-width controls at the bottom) — never a right-hand column — with everything tightened to fit the short height.
4. **The table absorbs leftover space** — `max-h-full` + height-driven felt means "no scrolling" is guaranteed by construction.
5. **The action bar never shrinks or scrolls** — it's `shrink-0`; when space is tight the table flattens instead.

### Rationale Q&A — why these specific values?

- **Why `svh` instead of `vh`?** Mobile browser chrome (address bar, bottom nav) makes `100vh` taller than the visible screen. `svh` = small viewport height = what's always visible, so the action bar can never be pushed under the browser UI.
- **Why a 4:5 portrait stadium?** A tall phone screen is best used by a *tall* table — straight sides, rounded caps top/bottom. Width is derived from height via `aspect-ratio: 4/5`, so the felt can never overflow the row's height.
- **Why do your hole cards live on the felt at your seat?** The old bottom-bar row (64×90 on desktop, 44×64 on portrait) cost a full row of vertical budget on every screen. Moving the cards to the felt reclaimed that row for the table (roughly 100px on desktop). **Why at the rail beside the seat rather than on the seat→pot line?** Two attempts to push the cards down that line (55% → 48% of the way) barely moved them: the bet chip (which stops at 30%) and the seat column block any lower position for bottom-center seats. Tucking the pair beside the avatar at the rail (top ~84%) is the only spot that reads as truly low, and it matches real poker tables. The card pair gets a fan + gold glow + turn-scale so it still reads clearly at a glance. On landscape phones they stay in the compact bottom bar because the flat 2:1 felt is too short to host them.
- **Why hide the last-action ticker on phones?** A full text row costs ~20px of vertical budget. The ticker is informational; the action buttons are what matter, so the table wins the pixels.
- **Why 2:1 in landscape?** Landscape screens are short and wide — the flattest oval maximizes felt area while the bottom bar keeps every button visible.
- **Why the 700px landscape threshold?** Phones whose *layout* viewport is taller than the *visible* area (browser chrome) must still get the compact landscape bar; 500px would leak the full-size portrait bar sideways onto them.
- **Why `!important` everywhere?** Mobile rules must beat both Tailwind utilities and the inline `style={{ width: dim.w }}` pixel sizes from `CARD_DIMENSIONS`.
- **Why hide only the bet slider in landscape?** Hiding the whole bet container once hid Raise/All-In too and players couldn't bet sideways. Presets + Raise + All-In stay; only the range slider is `display: none`.
- **Why CSS variables for card sizes?** Previously the same selector (e.g. `.landscape-hole-cards .card-front`) repeated 3× with different px values across breakpoints. Now there's one consumer rule and each breakpoint only redefines `--card-*` values — a size change is a one-line edit with no selector duplication.
- **Why was the header removed from the club room?** It cost ~40px of vertical budget on every screen. Leave and Cash Out now float as compact overlays over the table corners (root is `relative`, buttons are `absolute top-2 left-2` / `top-2 right-2`, z-40), so the felt gets the full screen height — the same pixel-saving philosophy as hiding the last-action ticker on phones.

---

*This guide covers the UI as of the current codebase. When in doubt, trust `frontend/src/mobile-overrides.css` (the media-query blocks + `--card-*` variables) as the source of truth for mobile spacing.*
