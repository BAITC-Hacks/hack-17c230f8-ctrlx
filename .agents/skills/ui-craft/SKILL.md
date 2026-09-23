---
name: ui-craft
description: Use for any user-facing UI work — building or restyling pages and components, choosing palette, typography and layout, writing UI copy, adding or reviewing animations and interactions. Merges a distinctive, subject-grounded visual direction with Emil Kowalski's motion and interaction craft, tuned for a 5-hour hackathon demo on Next.js 16 + Tailwind 4 + shadcn/Base UI or plain HTML/CSS. UI reviews come back as a Before | After | Why table.
license: Apache-2.0 AND MIT (LICENSE-frontend-design.txt, LICENSE-emil-design-eng.txt)
---

# UI Craft — a look nobody else has, motion that feels right, built for a 5-hour demo

> Combined and adapted by team CtrlX on 2026-09-23 from Anthropic's `frontend-design` skill (Apache-2.0) and Emil Kowalski's `emil-design-eng` skill (MIT, github.com/emilkowalski/skill @85e8e23). Changes: merged into one workflow, condensed, added hackathon, stack, finance and Kazakh-localization guidance. The full original texts are in `VISUAL.md` and `MOTION.md` — read them when you need depth.

You are two people at once: the design lead of a studio known for giving every client an identity nobody mistakes for anyone else's, and a design engineer who sweats the invisible details. When every demo "works", taste is the differentiator — and the jury sees the product for three minutes. Unseen details compound; beauty is leverage.

## 0. Budget first
- Order: the must-have scenario works end-to-end → visual direction → motion polish. Never polish a screen whose scenario doesn't work yet.
- Design pass before UI code: ≤ 10 minutes, producing the token plan from §2. Motion polish after the main scenario works (~15:50), done before the 16:30 feature freeze.
- Motion budget: 3–5 purposeful animations in the whole product (press feedback, result reveal, state change, toast). Everything else is instant.
- Tokens live in one file (`app/globals.css`, or the `<style>` in `static/index.html`). Not your zone → ask its owner.

## 1. Ground it in the subject
Read `docs/TASK.md` and `docs/REQUIREMENTS.md`: who is the partner, who is the user, what is the one job of this screen. The subject's industry, materials and vernacular are where distinctive choices come from — a tool for a bank's fraud analysts looks nothing like a student budgeting app. Build with the task's real content: real field names, sample records, real amounts in ₸ — never lorem ipsum.

In a hackathon product the hero is the working tool: the main scenario above the fold (input → decision → explanation), not a marketing landing. Open with the most characteristic thing in the subject's world.

## 2. Token plan — write it, then attack it
Before coding, write a compact plan in the chat:
- **Color**: 4–6 named hex values (base, surface, text, accent, 1–2 semantic). Semantic color never carries meaning alone.
- **Type**: one or two families with clear roles and a scale (e.g. 14 / 16 / 20 / 28 / 40). Russian UI → Cyrillic is mandatory; Kazakh text → extended glyphs (§5).
- **Layout**: a one-sentence concept + an ASCII wireframe of the main screen + the alignment rule.
- **Motion**: the easing tokens and durations below, and exactly which 3–5 moments animate.
- **Principle**: the one memorable thing. Spend boldness in one place; keep everything around it quiet and disciplined.

Then review the plan against the brief: if any part reads like what you would produce for any similar page, revise it and say what you changed and why. Only then write code.

Implement the tokens once:
```css
/* app/globals.css — shadcn components read these variables; never hardcode colors in components */
:root { --background: …; --foreground: …; --primary: …; --radius: …; }
@theme {
  --font-sans: var(--font-body);                          /* from next/font */
  --ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1);      /* enter / exit, UI feedback */
  --ease-in-out-strong: cubic-bezier(0.77, 0, 0.175, 1);  /* movement on screen */
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);          /* sheets, drawers */
}
```
Tailwind 4 turns `--ease-*` into utilities (`ease-out-strong`). Plain HTML/CSS: the same values as variables in `:root`.

## 3. Don't look generated
Generated UIs cluster around a few looks. Each is legitimate for some brief, but they are defaults, not choices — when the brief leaves an axis free, don't spend it on them:
1. warm cream background (~#F4F1EA) + high-contrast serif + terracotta accent (~#D97757);
2. near-black background + one acid-green or vermilion accent;
3. broadsheet layout: hairline rules, zero radius, dense columns;
4. the SaaS-card kit: identical rounded cards, one radius everywhere, the same soft grey shadow, gradient washes as decoration;
5. template chrome: tracked-out ALL-CAPS eyebrows over every heading, `A · B · C` meta strings, `WORD — fragment` labels, #0B0B0B/#111 instead of black, monospace for small labels, `→` appended to buttons.

Also avoid: accenting one word of a headline, all-caps labels, labels above content that say nothing, the big-number-small-label-gradient hero by reflex, numbered markers (01/02/03) for things that are not a sequence. Structure — borders, dividers, labels — must encode information, not decorate.

## 4. Copy is design
Words exist to make the interface easier to use. Use the task's language (Russian by default), sentence case, active voice, plain verbs.
- Name things by what the user understands, not how the system is built: «Проверить заявку», not «Запустить пайплайн».
- A CTA says exactly what happens, and an action keeps its name through the flow: «Отправить» → toast «Отправлено».
- Errors say what happened and how to fix it — no apologies, never vague. An empty screen invites the next action.
- One element, one job. No filler.

## 5. Typography, numbers, localization
- Pick typefaces deliberately, not the family you reach for on every project; one or two, clearly distinct. Load with `next/font` using `subsets: ['latin', 'cyrillic']` (+ `'cyrillic-ext'` where offered).
- Cyrillic-capable candidates to evaluate: Onest, Golos Text, Manrope, IBM Plex Sans, PT Sans / PT Serif, Literata, Unbounded (display only), JetBrains Mono (figures and code). In the browser, check the chosen weights render Russian and Kazakh: «Ә ә Ғ ғ Қ қ Ң ң Ө ө Ұ ұ Ү ү Һ һ І і». A fallback font mid-word looks broken.
- Line length under 80 characters; serif body gets a bit more line height. Body text ≥ 16 px — the demo runs on a projector.
- Money and metrics: `tabular-nums`, right-aligned in tables, `new Intl.NumberFormat('ru-KZ', { style: 'currency', currency: 'KZT', maximumFractionDigits: 0 })`; dates with `Intl.DateTimeFormat('ru-KZ')`. Always show units; round consistently.
- Scores and confidence: number + bar + words («высокий риск · 0,82»), never color alone.

## 6. Motion — decide before you animate
1. **Should it animate?** How often will people see it? 100+ times a day (shortcuts, command palette) → never. Tens of times (hover, list navigation) → remove or drastically reduce. Occasional (modals, drawers, toasts) → standard. Rare (onboarding, success) → room for delight. Never animate keyboard-initiated actions.
2. **What is it for?** Spatial consistency, state indication, explanation, feedback, preventing a jarring change. "Looks cool" on a frequent element → don't.
3. **Easing.** Entering or exiting → ease-out. Moving or morphing on screen → ease-in-out. Hover and color → ease. Constant motion (progress) → linear. Default → ease-out. Use the strong curves from §2 — the built-in CSS easings are too weak. **Never ease-in for UI**: it delays the exact moment the user is watching.
4. **Duration.** Press feedback 100–160 ms · tooltips and small popovers 125–200 ms · dropdowns and selects 150–250 ms · modals and drawers 200–500 ms. UI stays under 300 ms; faster feels more responsive — a faster spinner makes the same wait feel shorter.

Springs (`{ type: "spring", duration: 0.5, bounce: 0.2 }` in Motion) for drags, interruptible gestures and elements that should feel alive; keep bounce at 0.1–0.3, and avoid it in serious finance screens. Clip-path recipes, gestures, performance details: `MOTION.md`.

## 7. Component craft
- Pressables answer: `active:scale-[0.97] transition-transform duration-150 ease-out-strong`, set once in `components/ui/button.tsx`.
- Nothing appears from nothing: enter from `scale(0.95)` + `opacity: 0`, never `scale(0)`.
- Popovers grow from their trigger: `origin-(--transform-origin)` (Base UI provides the variable). Modals stay centered.
- Base UI entry and exit: `data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0`. Plain CSS: `@starting-style`.
- Tooltips: delay the first one; adjacent ones then open instantly, with no animation.
- Anything retriggered quickly (toasts, toggles): CSS transitions, not keyframes — transitions retarget, keyframes restart from zero.
- A crossfade that looks like two objects swapping → add `filter: blur(2px)` during the transition (keep blur small; Safari).
- Items entering together: stagger 30–80 ms each; never block interaction while it plays.
- Exit faster than enter. Slow where the user decides (hold-to-confirm: 2 s linear), fast where the system responds (release: 200 ms ease-out).
- Animate `transform` and `opacity` (sparingly `clip-path`, `filter`). Never `transition: all`. In Motion, animate `transform: "translateX(…)"` rather than `x`/`y` when the page is busy.

## 8. Moments that win an AI demo
- **Show the agent working.** Render the pipeline as steps (received → rules checked → model asked → decided) that appear with a short stagger as each completes, one line of result per step. This is state indication, not decoration.
- **Human in the loop.** The decision is a proposal with reasons and a clear confirm / override; after the action the state visibly changes in place — a morph, not a page jump.
- **Waiting.** Skeletons shaped like the result, a fast spinner, input stays editable; show progress or elapsed time after 2 s.
- **Honesty.** The LLM / DEMO badge stays visible; fallback results are labeled, not hidden.
- **Demo-proof.** Right at 1280×800 (projector) and 375 px (phone), high contrast, no information that exists only on hover.

## 9. Quality floor — always, without announcing it
Responsive down to mobile, visible keyboard focus, `prefers-reduced-motion` (keep opacity and color fades, drop movement), hover effects inside `@media (hover: hover) and (pointer: fine)`, accessible contrast, harmonious palette. Before calling it done: take a screenshot in the browser and remove one accessory; replay animations at 2–5× duration (DevTools → Animations) to catch overlapping states and wrong origins.

## 10. Review format (required)
When reviewing UI code, answer with a single markdown table — never "Before:/After:" lines:

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms var(--ease-out-strong)` | name the property; strong ease-out |
| `transform: scale(0)` on enter | `scale(0.95); opacity: 0` | nothing appears from nothing |
| `ease-in` on a dropdown | `ease-out-strong` | ease-in feels sluggish |
| no `:active` on a button | `active:scale-[0.97]` | a press must feel heard |
| popover `origin-center` | `origin-(--transform-origin)` | grow from the trigger (modals exempt) |
| status shown by red/green only | icon + text + color | color alone fails accessibility and projectors |
| default font + gradient hero | tokens from the plan | template look, no identity |

Also check: animation on a keyboard action · UI duration over 300 ms · hover without the media query · keyframes on something retriggered quickly · same enter and exit speed · everything appearing at once · a look from §3 · copy describing the system instead of the user's task · missing Cyrillic or Kazakh glyphs · money without `tabular-nums` and ₸.

## References
- `VISUAL.md` — the full visual-direction guidance and the calibration of AI-default looks (original `frontend-design` text).
- `MOTION.md` — the full motion and interaction craft: springs, clip-path, gestures, performance, the Sonner principles, debugging (original `emil-design-eng` text).
