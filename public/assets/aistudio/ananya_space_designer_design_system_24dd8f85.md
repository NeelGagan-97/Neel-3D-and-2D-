---
name: "Ananya Space Designer"
description: "Precision dark-mode architectural and electrical CAD engineering design system with Deep Navy grounds, Dark Slate panels, Electric Blue primary controls, and Amber Orange electrical accents."
---

## Overview

Ananya Space Designer is a professional architectural and electrical planning software suite built for residential space design, 2D/3D spatial modeling, and automated electrical load & Bill of Quantities (BOQ) engineering. The interface embodies **precision CAD craftsmanship**: high-contrast technical legibility, disciplined tonal layering, crisp hairline panel dividers, and a distraction-free dark workspace where the 3D architectural model and electrical schematics command full visual attention.

The target audience includes architects, interior designers, electrical engineers, and detail-oriented homeowners planning residential apartments. Every surface, control, and data table prioritizes spatial clarity, tabular precision, and immediate visual feedback.

## Colors

The palette is anchored in **Deep Navy** (`#080F20`) for the primary workspace ground and **Dark Slate** (`#111C31`) for elevated toolbars, sidebars, and inspector panels. **Electric Blue** (`#00A8FF`) drives primary interactive actions, active 2D/3D view states, and selection highlights, while **Amber Orange** (`#FF9D00`) signifies live electrical power, wattage loads, and high-priority engineering callouts. **Metallic Silver** (`#C5CDD8`) provides calm, legible secondary metadata, paired with crisp **White** (`#F5F7FA`) for primary headings and numerical readouts.

- **Deep Navy (`#080F20`):** Primary application background and 3D viewport ground.
- **Dark Slate (`#111C31`):** Elevated sidebars, property inspectors, cards, and data panels.
- **Electric Blue (`#00A8FF`):** Primary CTAs, active tool states, selected canvas nodes, and structural guides.
- **Amber Orange (`#FF9D00`):** Electrical load indicators, circuit badges, wattage totals, and secondary highlights.
- **Metallic Silver (`#C5CDD8`):** Secondary labels, coordinates, axis markers, and inactive navigation items.
- **White (`#F5F7FA`):** Primary typography, active navigation labels, and key metric values.

```yaml
colors:
  deep-navy: "#080F20"
  dark-slate: "#111C31"
  electric-blue: "#00A8FF"
  amber-orange: "#FF9D00"
  metallic-silver: "#C5CDD8"
  studio-white: "#F5F7FA"

  primary: "#00A8FF"
  on-primary: "#080F20"
  primary-container: "#0B2948"
  on-primary-container: "#E0F4FF"

  secondary: "#FF9D00"
  on-secondary: "#080F20"
  secondary-container: "#332208"
  on-secondary-container: "#FFE2B3"

  surface: "#080F20"
  surface-container-low: "#0D1528"
  surface-container: "#111C31"
  surface-container-high: "#182742"
  surface-container-highest: "#203254"

  on-surface: "#F5F7FA"
  on-surface-variant: "#C5CDD8"
  outline: "#2C3E5E"
  outline-variant: "#1D2B44"

  success: "#22C55E"
  on-success: "#052E16"
  warning: "#FF9D00"
  on-warning: "#080F20"
  error: "#EF4444"
  on-error: "#1C1C1C"
```

## Typography

The typography system pairs **Red Hat Text** for geometric architectural headings, **Instrument Sans** for crisp UI controls and body copy, and **Red Hat Mono** for coordinates (`X`, `Y`, `Z`), room dimensions, connected electrical loads (`kW`, `W`), and BOQ currency figures. All numeric readouts and table columns use `tabular-nums` so values align cleanly without horizontal jitter.

```yaml
typography:
  display-lg:
    fontFamily: "Red Hat Text"
    fontSize: 48px
    fontWeight: 700
    lineHeight: 54px
    letterSpacing: -0.5px
  display-lg-mobile:
    fontFamily: "Red Hat Text"
    fontSize: 32px
    fontWeight: 700
    lineHeight: 38px
    letterSpacing: -0.25px
  headline-lg:
    fontFamily: "Red Hat Text"
    fontSize: 36px
    fontWeight: 700
    lineHeight: 44px
    letterSpacing: -0.25px
  headline-lg-mobile:
    fontFamily: "Red Hat Text"
    fontSize: 26px
    fontWeight: 700
    lineHeight: 32px
    letterSpacing: -0.25px
  headline-md:
    fontFamily: "Red Hat Text"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 30px
    letterSpacing: 0px
  headline-sm:
    fontFamily: "Red Hat Text"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 24px
    letterSpacing: 0px
  title-md:
    fontFamily: "Instrument Sans"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 22px
    letterSpacing: 0px
  title-sm:
    fontFamily: "Instrument Sans"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
    letterSpacing: 0px
  body-lg:
    fontFamily: "Instrument Sans"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    letterSpacing: 0px
  body-md:
    fontFamily: "Instrument Sans"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0px
  body-sm:
    fontFamily: "Instrument Sans"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: 0px
  label-lg:
    fontFamily: "Instrument Sans"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
    letterSpacing: 0.25px
  label-md:
    fontFamily: "Instrument Sans"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 16px
    letterSpacing: 0.25px
  label-sm:
    fontFamily: "Instrument Sans"
    fontSize: 11px
    fontWeight: 600
    lineHeight: 14px
    letterSpacing: 0.5px
  mono-md:
    fontFamily: "Red Hat Mono"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 18px
    letterSpacing: 0px
  mono-sm:
    fontFamily: "Red Hat Mono"
    fontSize: 11px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0px
```

## Layout & Spacing

The application follows a **4px base grid** with two distinct density modes:
- **Editorial Landing & Summary Mode (Home & Project Summary):** Uses a 12-column responsive grid with generous `24px`–`32px` gutters and `48px` vertical section rhythm, framed within a `1280px`–`1440px` max container.
- **Studio Workspace Mode (Design Studio):** Full-bleed desktop-first CAD layout (`min-h-screen`) with a `56px` top toolbar, `280px` collapsible left component library, fluid central 2D/3D canvas, `288px` right properties inspector, and `36px` bottom telemetry status bar. On smaller viewports, sidebars collapse cleanly behind toggle drawers.

```yaml
spacing:
  gutter-xs: 4px
  gutter-sm: 8px
  gutter-md: 12px
  gutter-lg: 16px
  gutter-xl: 24px
  gutter-2xl: 32px
  section: 48px
  page-margin: 24px
```

## Elevation & Depth

Depth is communicated through **tonal surface stepping** (`#080F20` → `#0D1528` → `#111C31` → `#182742`) combined with crisp `1px` structural hairline borders (`#2C3E5E` and `#1D2B44`). Heavy drop shadows are avoided on workspace panels to preserve a flat, high-precision CAD aesthetic; subtle ambient shadows are reserved only for floating canvas toolbars and modal overlays.

## Shapes

Corner radii are disciplined and technical: `4px` for compact inputs, coordinate fields, and CAD tool buttons; `8px` for cards, inspector panels, and primary action buttons; `12px` for feature containers and 3D preview viewports; and `9999px` for status pills and circuit indicators.

```yaml
rounded:
  sm: 4px
  DEFAULT: 8px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
```

## Motion & Micro-interaction

Interactions are immediate and mechanical. Button hover states, tool switches, and panel accordions snap within `100ms–150ms` using `ease-out` curves. Viewport transitions (2D/3D camera switches, daylight/evening lighting toggles) animate smoothly over `250ms` without layout shifts. Nothing loops or pulses decoratively.

```yaml
motion:
  state-change:
    duration: 100ms
    delay: 0ms
    timingFunction: ease-out
  panel-toggle:
    duration: 150ms
    delay: 0ms
    timingFunction: cubic-bezier(0.2, 0, 0, 1)
  viewport-transition:
    duration: 250ms
    delay: 0ms
    timingFunction: cubic-bezier(0.2, 0, 0, 1)
```

## Voice & Content Strategy

- **Tone:** Authoritative, engineering-grade, concise, and practical. Avoid marketing fluff or buzzwords.
- **Capitalisation:** Sentence case for UI labels, inspector fields, and descriptions; Title Case for major navigation items and section titles; UPPERCASE reserved strictly for primary brand CTAs requested in the spec (`CREATE YOUR OWN SPACE`, `EXPLORE 3D DESIGN`) and compact CAD group headers.
- **Terminology:** Consistently use *Site Dimensions*, *Connected Load*, *Circuit Assignment*, *Bill of Quantities (BOQ)*, *2D Plan*, and *3D Model*.
- **Units & Formatting:** Use metric/imperial consistently (`ft` / `m`), `W` and `kW` for electrical loads, `230V / 50Hz` standard residential voltage, and Indian Rupee (`₹`) formatting with `tabular-nums` for BOQ cost estimates.

## Components

Component implementations live as individual HTML sticker sheet files in
`components/`. Each file contains the canonical, styled HTML components with
`<!-- COMPONENT: name -->` comment markers. Read each file before use.

- **Accordion** → `@components/accordion.html`: `accordion-single`, `accordion-group`
- **Button** → `@components/button.html`: `button-primary`, `button-icon`, `button-with-icon`
- **Card** → `@components/card.html`: `card-elevated`, `card-action`, `card-interactive`, `card-interactive-2`
- **Input Field** → `@components/input-field.html`: `input-field-text`, `input-field-icon`
- **Table** → `@components/table.html`: `table-standard`, `table-interactive`, `table-selectable`
