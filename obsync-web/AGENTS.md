# Obsync Web UI Design Rules (Precision Ink)

Follow these rules for all UI, styling, and component work in `obsync-web/`.

## Theme, Palette & Depth
- **Default `obsync` theme (`src/index.css`):** True neutral obsidian charcoal (`--color-base-100: oklch(14.5% 0.002 260)`, `#0d0d0e`), stepped neutral surfaces (`base-200`, `base-300`), softened off-white ink (`oklch(93.5% 0.002 260)`), and one restrained steel-blue accent (`--color-primary: oklch(64% 0.135 252)`).
- **Radii:** Tool-grade proportions (`--radius-box: 0.5rem`, `--radius-field: 0.4375rem`, `rounded-md` / `rounded-lg` on panels, controls, and inputs). Avoid `rounded-2xl` / `rounded-full` pill inflation.
- **Flat depth model:** Separate surfaces with tonal steps and `1px` hairline borders (`border-base-content/10` to `/15`). Never add `.bg-ambient-glow`, radial blobs, gradient icon badges, `shadow-primary/*` glows, or `backdrop-blur-*` on cards, modals, headers, or nav bars.
- **Offline / CSP font policy:** Do not load external web fonts (violates CSP and offline zero-knowledge design). Use the native system sans and monospace stacks defined in `src/index.css`.

## Layout & Chrome Invariants
- **No brand header block:** Do not render a `[Shield] Obsync` brand emblem in the desktop left sidebar (`src/App.tsx`) or the mobile top bar (`src/components/StorageStatusBar.tsx`).
- **Top baseline alignment:** The desktop sidebar starts directly with `Quick jump… Ctrl K` (`h-7` with `pt-2`), aligned horizontally with the `min-h-11` `StorageStatusBar` (`h-7` controls).
- **No duplicate chrome:** Keep the header `Command` trigger mobile-only (`md:hidden`) and do not show passive `Locked` badges in the top bar (the sidebar footer already displays vault lock state). Only show interactive lock actions (`Lock Vault`, `Lock Keys`) when unlocked.
- **Single primary CTA per view:** When no providers exist, keep the top status bar as a quiet `No storage connected` status button and empty-state buttons as secondary hairline controls so `+ Add Provider` remains the single primary CTA.

## Component Craft & Copy
- **Neutral navigation & segmented controls:** Active sidebar links, note list selections, `Read / Edit / Split` tabs (`MarkdownView.tsx`), and modal provider tabs (`SettingsView.tsx`) use neutral surface contrast—reserve `btn-primary` strictly for high-intent actions (`Save` when dirty, form submit, `+ Add Provider`).
- **Destructive buttons:** Permanent toolbar delete/remove icons (`Trash2`) stay muted (`btn-ghost text-base-content/50`) and reveal `hover:bg-error/10 hover:text-error` on interaction.
- **Forms & contrast:** Every modal/form input must have a visible `<label>` above it (no placeholder-only inputs). Preserve readable disabled button contrast (`.btn:disabled` rule in `src/index.css`).
- **Editor & reader restraint:** Keep CodeMirror Markdown highlighting typographic (headings in `base-content`, muted syntax punctuation, subtle neutral active line) and apply `tabular-nums` to note counts, dates, word counts, and `Ln/Col` readouts.
- **Icons & copy:** Use `lucide-react` icons consistently (no raw Unicode emojis like `🔒` in UI chrome), and never mention internal UI libraries (e.g., `DaisyUI`) in user-facing copy.

## Verification
After UI changes in `obsync-web/`, run:
```sh
npm run typecheck && npm run build && npm test
```
and visually inspect the live app in the browser to verify alignment, wrapping, and contrast.
