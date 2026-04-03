# UI Kit — Atoms / Molecules / Organisms (2026-04-03)

## Current state

**47 UI components** in `components/ui/`:

- Atoms (28): Button (4 variants), Badge (semantic variants), Input, Textarea, Select, Markdown, Label, Checkbox, Switch, Radio, Tooltip, Popover, Spinner, Avatar, Icon, Separator, EmptyState, StatusDot, AlertBox, ToggleButton, ProgressBar, FileInput, KeyHint, SectionHeader, ScrollableContainer, IconLabel, TimestampLabel, FilterButton, Skeleton, AttachmentChip, AuthorBadge, SourceIcon
- Molecules (19): Dialog, Sheet, Tabs, Card, Collapsible, DropdownMenu, SegmentedControl, FormField, FormDialog, InlineEditor, Metric, MetadataRow, ActionButtonGroup, StickyActionBar, ListButton, DropZone, TableHeaderCell, FileListItem, TaskTagsList, Toast (ToastProvider + useToast)
- Hooks (3 new): useDensityClasses, useTaskFiltering, useFormState
- Utilities (1 new): formatFileSize
- All clean — no business logic, CVA variants, Tailwind, `cn()` utility

Architecture is correct. Design tokens complete for Phase 1 (status, priority, feedback, agent/tool colors).

---

## CRITICAL: Pencil Design Sync

Every new or updated UI component MUST be added to the Pencil design file via MCP (`mcp__pencil__batch_design`). This keeps the design source of truth in sync with code.

**Workflow per component:**

1. Implement the component in code (`components/ui/`)
2. Use `mcp__pencil__get_editor_state` to check active `.pen` file
3. Use `mcp__pencil__batch_design` to add/update the component in Pencil with all variants, states, and props
4. Verify with `mcp__pencil__batch_get` that the design matches the implementation

**Current Pencil sync status (`aif-handoff-ui-kit.pen`):**

- [x] Design tokens (all 38 variables, dark/light themes)
- [x] Button (default, outline, ghost, xs)
- [x] Badge (default, priority)
- [x] Input
- [x] Checkbox, Switch
- [x] StatusDot, AlertBox, Spinner, EmptyState
- [x] KeyHint, SectionHeader, IconLabel, TimestampLabel
- [x] Metric
- [x] Card, FormField, Tabs, SegmentedControl
- [x] Collapsible, DropdownMenu
- [ ] Remaining atoms: Tooltip, Popover, Avatar, Separator, ProgressBar, FilterButton, Skeleton, AttachmentChip, AuthorBadge, SourceIcon, ToggleButton, FileInput, ScrollableContainer, Radio, Label
- [x] DropZone, TableHeaderCell, FileListItem, TaskTagsList, Toast
- [ ] Remaining molecules: Dialog, Sheet, FormDialog, InlineEditor, MetadataRow, ActionButtonGroup, StickyActionBar, ListButton

---

## Migration strategy

**Per component:**

1. Create the atom/molecule in `components/ui/` with CVA variants, tokens only — no hardcoded colors/sizes
2. Migrate ALL consumers to use the new component in the same PR
3. Delete the old inline code / local component
4. Run `npm run lint` + `npm test` — maintain 70% coverage

**Why same-PR?** Extracting without migrating creates dead code and two sources of truth. Keep the blast radius visible in one diff.

## Testing

Every new `components/ui/` component must have a corresponding test file (`*.test.tsx`) covering:

- All CVA variants render correctly
- Interactive states (click, focus, disabled) where applicable
- Accessibility: correct ARIA attributes, keyboard navigation
- Edge cases: empty content, long text, missing optional props

Target: **70% coverage minimum** per CLAUDE.md rules. Hooks need unit tests with `renderHook()`.

---

## Missing atoms

All 28 atoms from original list are now implemented:

- [x] Label
- [x] Checkbox
- [x] Switch
- [x] Radio
- [x] Tooltip
- [x] Popover
- [x] Spinner / Loader
- [x] Avatar
- [x] Icon wrapper
- [x] Separator / Divider
- [x] EmptyState
- [x] StatusDot
- [x] AlertBox
- [x] ToggleButton
- [x] ProgressBar
- [x] FileInput
- [x] KeyHint
- [x] Button `size="xs"` variant
- [x] Badge semantic variants
- [x] ScrollableContainer
- [x] IconLabel
- [x] TimestampLabel
- [x] FilterButton
- [x] Skeleton
- [x] SectionHeader
- [x] AttachmentChip
- [x] AuthorBadge
- [x] SourceIcon

## Missing molecules

- [x] DropdownMenu
- [x] Tabs
- [x] FormField (Label + Input + Error)
- [x] Card
- [x] Collapsible
- [x] InlineEditor
- [x] Metric
- [x] ListButton
- [x] MetadataRow
- [x] FormDialog
- [x] ActionButtonGroup
- [x] StickyActionBar
- [x] SegmentedControl
- [x] DropZone — drag-and-drop area with hover styles; TaskAttachments migrated
- [x] TableHeaderCell — uppercase tracking-wide muted headers; Board table (5 instances) migrated
- [x] FileListItem — name + mime + size + download/remove actions; TaskAttachments migrated
- [x] TaskTagsList — tag filtering + Badge mapping; TaskCard, TaskDetailHeader migrated
- [x] Alert / Toast — ToastProvider + useToast notification system

## Organism refactors

- [ ] `Header.tsx` (35KB) — split into Header + HeaderActions / Metrics / Import subcomponents
- [ ] `Board.tsx` (430 lines) — extract filter/sort logic into custom hook
- [ ] `AddTaskForm.tsx` (373 lines) — rewrite on FormField molecules
- [ ] `TaskDetail` (13 files) — add barrel export, review reuse opportunities
- [ ] `ConfigEditor.tsx` — extract SectionTitle + Field + ToggleField into reusable pattern; 8+ section groups with repeated structure
- [ ] `Board.tsx` — extract `FilterBar` organism (filter toggle strip, 2 instances: main + roadmap)
- [ ] `Board.tsx` — extract `TaskListTable` organism (thead/tbody/sort/search, lines 335-425)
- [ ] `ChatPanel.tsx` (553 lines) — extract inline CreateTaskCard, MessageBubble, TypingIndicator into separate files
- [ ] `ConfirmDialog` — promote from `task/ConfirmDialog.tsx` to `ui/` as reusable molecule (already extracted, wrong location)

## Custom hooks to extract

- [x] `useDensityClasses()` — replaces `isCompact ? "px-2" : "px-3"` pattern (30+ locations)
- [x] `useTaskFiltering()` — filter/sort/search logic from Board.tsx
- [x] `useFormState()` — multi-field form state + dirty tracking + reset
- [ ] `useEditMode()` — `isEditing` + value + save/cancel logic; TaskDescription, SessionList, TaskSettings
- [ ] `useActivityLogParsing()` — parsing + filtering from AgentTimeline
- [ ] `useStatusColor()` — status/kind -> color class mapping; TaskCard, Column, AgentTimeline, TaskDetailHeader (4+); subsumes `statusColorStyle()` utility below
- [ ] `useOutsideClick(ref, callback)` — close on click outside; ProjectSelector, ChatPanel, CommandPalette (3+)
- [ ] `useKeyboardShortcut(key, handler)` — scattered useEffect+keydown in App.tsx (Cmd+K/N), ChatPanel (Enter+Shift), SessionList (Enter/Escape) (3+)

## Accessibility fixes

- [ ] Add `aria-label` to all icon-only buttons (TaskDescription, TaskAttachments, ChatPanel)
- [ ] Add `htmlFor` to `<label>` elements (AddTaskForm, TaskSettings)
- [ ] Add `aria-expanded` on collapsible sections (TaskPlan, TaskAttachments)
- [ ] Add `aria-live` on success/error messages (TaskDetail, TaskDetailHeader)
- [ ] Standardize `focus-visible` ring styles across all interactive elements

## Utilities to extract / consolidate

- [x] `formatFileSize()` — `bytes -> KB/MB` display
- [ ] Consolidate `timeAgo` — duplicated in SessionList (`formatRelativeTime`) instead of using `utils.ts` (`timeAgo`)
- [ ] `statusColorStyle()` — pure utility function inside `useStatusColor()` hook; implement together

## Design tokens — audit & enforce

### Phase 1 — Status, Priority, Feedback, Agent colors: DONE

All token categories defined in `index.css` (dark + light themes):

- [x] Status colors (`--color-status-*`)
- [x] Priority colors (`--color-priority-*`)
- [x] Feedback colors (`--color-success/warning/info` + foreground)
- [x] Agent/tool colors (`--color-agent/tool/tool-error` + foreground)

### Phase 2 — Standardize typography scale: TODO

- [ ] Define named font-size tokens: `--text-2xs` (9px), `--text-xs` (10px), `--text-sm` (11px), or use Tailwind `@theme` extension
- [ ] Replace all `text-[10px]`, `text-[9px]`, `text-[11px]` (84 occurrences) with token references
- [ ] Define `--font-mono` token for timestamp/ID displays; standardize across TaskCard, AgentTimeline, SessionList

### Phase 3 — Standardize spacing scale: TODO

- [ ] Audit and consolidate arbitrary spacing values (`px-[6px]`, `gap-[3px]`, `py-[2px]`)
- [ ] Define density-aware spacing tokens: `--space-dense-x`, `--space-dense-y`, `--space-comfortable-x`, `--space-comfortable-y`
- [ ] Replace hardcoded density ternaries (`isCompact ? "px-1.5" : "px-2"`) with token-based `useDensityClasses()`

### Phase 4 — Lint enforcement: TODO

- [ ] Add Stylelint / ESLint rule to ban raw Tailwind color classes outside `ui/` primitives (e.g. `no-restricted-syntax` for `emerald-`, `cyan-`, etc.)
- [ ] Add Stylelint rule to ban arbitrary `text-[Npx]` values outside `index.css` token definitions

## Storybook

- [ ] Storybook setup for isolated component dev and docs

---

## Remaining estimate

| Phase                                            | Effort       |
| ------------------------------------------------ | ------------ |
| Design tokens Phase 2-3 (typography + spacing)   | ~1.5 days    |
| Design tokens Phase 4 (lint enforcement)         | ~0.5 day     |
| ~~Remaining molecules (5 items)~~                | ~~DONE~~     |
| Custom hooks extraction (5 remaining)            | ~1 day       |
| Utilities consolidation                          | ~0.25 day    |
| Refactor organisms onto new components (9 items) | ~3.5 days    |
| Accessibility fixes                              | ~1 day       |
| Pencil sync (remaining components)               | ~0.5 day     |
| Storybook (optional)                             | ~1 day       |
| **Total remaining**                              | **~10 days** |

**Recommended order:**

1. **Design tokens Phase 2-3** — typography + spacing standardization
2. **Remaining molecules** — DropZone, TableHeaderCell, FileListItem, TaskTagsList, Toast
3. **Custom hooks** — useEditMode, useActivityLogParsing, useStatusColor, useOutsideClick, useKeyboardShortcut
4. **Organism refactors** — rewrite on ready atoms/molecules
5. **Lint enforcement Phase 4** — after migration complete
6. **Accessibility + Storybook** — final layer

## Notes

- Stack is already correct: CVA + Tailwind + cn() — no framework changes needed
- Theme tokens defined in `src/index.css` via CSS variables (dark/light) — Phase 1 complete
- Icons: lucide-react throughout
- No external UI framework (no shadcn, no Radix, no MUI)
- Pencil design file: `aif-handoff-ui-kit.pen` — 38 variables, 29 reusable components
