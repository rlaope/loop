# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-06-16
- Primary product surfaces: Loop Prompt Console TUI, processing console, Loop Wiki dashboard, CLI help.
- Evidence reviewed: README.md, src/core/tui.js, src/core/tui-render.js, test/tui.test.js.

## Brand
- Personality: focused, technical, safety-first, slightly warm.
- Trust signals: visible agent state, wiki state, run state, next action, logs, verification evidence.
- Avoid: marketing pages, decorative gradients, command-dump screens, unclear background activity.

## Product goals
- Goals: make Loop feel like a coding-agent harness where the user types goals, watches runs, and resumes context.
- Non-goals: replace Codex or Claude Code UI, become a full IDE, or hide verification responsibility from the engineer.
- Success signals: the user can see the current agent, wiki status, selected run, next action, and log entry point without reading docs.

## Personas and jobs
- Primary personas: engineers running coding-agent loops locally.
- User jobs: start a loop, inspect an active run, read context, open logs, continue a run, record evidence, complete a run.
- Key contexts of use: terminal-first local development, short feedback loops, intermittent dashboard usage.

## Information architecture
- Primary navigation: prompt input first, run stack second, selected run details third, action buttons fourth.
- Core routes/screens: no-argument prompt console, live processing console, dashboard, graph view, note view, log view.
- Content hierarchy: current objective and state before historical data; next action before secondary metadata.

## Design principles
- Principle 1: The TUI is a prompt surface, not a command catalog.
- Principle 2: Status must be observable before the user acts.
- Tradeoffs: dense terminal UI is acceptable, but labels must stay stable and scannable.

## Visual language
- Color: restrained red/yellow terminal palette with green only for healthy/complete states.
- Typography: terminal-native monospace; short labels; no viewport-scaled type.
- Spacing/layout rhythm: boxed sections with predictable top-to-bottom flow.
- Shape/radius/elevation: box-drawing borders only.
- Motion: simple spinner for processing state.
- Imagery/iconography: ASCII LOOP startup logo and text-native buttons.

## Components
- Existing components to reuse: prompt box, harness status, run stack, selected run panel, action bar, live log.
- New/changed components: phase rail, status pills, grouped action buttons, compact run identifiers.
- Variants and states: no runs, selected run, active run, completed run, dashboard online/off/unknown/blocked, processing locked prompt.
- Token/component ownership: src/core/tui-render.js owns terminal composition; src/core/tui.js owns interaction and side effects.

## Accessibility
- Target standard: readable terminal defaults with no color-only meaning.
- Keyboard/focus behavior: prompt remains the only text entry focus; visible buttons map to keyboard inputs.
- Contrast/readability: no low-contrast body text in essential state labels.
- Screen-reader semantics: plain text output remains meaningful without ANSI color.
- Reduced motion and sensory considerations: spinner is minimal and no persistent animation is required for static renders.

## Responsive behavior
- Supported breakpoints/devices: interactive terminals from 72 to 120 columns.
- Layout adaptations: renderer clamps width and wraps content inside boxes.
- Touch/hover differences: not applicable for terminal UI.

## Interaction states
- Loading: processing console with locked prompt and live log.
- Empty: first-run prompt mode with empty run stack.
- Error: action failures appear in Last Event.
- Success: action success appears in Last Event and updated run/wiki state.
- Disabled: prompt is locked while a direct run is processing.
- Offline/slow network, if applicable: wiki dashboard probe can show unknown instead of blocked.

## Content voice
- Tone: direct, engineering-focused, calm.
- Terminology: prompt, run, Loop, wiki, dashboard, next action, evidence.
- Microcopy rules: prefer labels over instructions; keep full explanations in README.

## Implementation constraints
- Framework/styling system: Node.js terminal renderer with ANSI color and box drawing.
- Design-token constraints: no new runtime dependency for TUI rendering.
- Performance constraints: render from local state with lightweight dashboard probe.
- Compatibility constraints: preserve CLI command behavior and non-TTY guidance.
- Test/screenshot expectations: use render tests and CLI smoke tests for stable terminal output.

## Open questions
- [ ] Whether future TUI input should support true arrow-key button navigation / owner: product / impact: interaction model.
- [ ] Whether dashboard and TUI should share a formal UI state model / owner: engineering / impact: consistency.
