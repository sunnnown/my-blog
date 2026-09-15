# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A static blog generator/viewer that reads Markdown files and renders them as a blog website. No backend, no build framework — implemented in plain HTML, CSS, and JavaScript only (no React/Vue/Svelte, no bundler-dependent framework, no CSS framework like Tailwind/Bootstrap).

## Constraints

- **No frameworks or heavy dependencies.** Stick to vanilla HTML/CSS/JS. If a small standalone library (e.g. a Markdown parser) is unavoidable, prefer a single-file, no-build-step library loaded via `<script>`, and keep it isolated so it's easy to rip out.
- **Design goals:** clean, readable typography-first layout suitable for long-form reading (sensible line length, spacing, font sizing).
- **Dark mode is required.** Support both light and dark themes — respect `prefers-color-scheme` and ideally give the reader a manual toggle, persisted (e.g. `localStorage`).
- **Mobile-first responsiveness is required.** Layouts must work well on small screens, not just be "not broken."

## Architecture

Everything is rendered client-side; there is no build step and no server-side rendering.

- `index.html` / `post.html` — the two pages. `index.html` lists posts; `post.html` renders one post based on the `?slug=<slug>` query param.
- `posts/posts.json` — manifest of all posts (`file`, `title`, `date`, `excerpt`). This is the source of truth for the post list; it must be kept in sync manually whenever a post is added or removed, since there is no way to list a directory's contents from client-side JS on a static host.
- `posts/*.md` — post content. Each file starts with a `---`-delimited frontmatter block (`title`, `date`, `excerpt`) followed by the Markdown body.
- `js/theme.js` — dark/light theme toggle, persisted to `localStorage` under `theme`. An inline `<script>` in the `<head>` of each HTML page applies the saved theme before first paint to avoid a flash. CSS itself falls back to `prefers-color-scheme` when no theme is saved (see `css/style.css`'s `:root` / `[data-theme]` rules).
- `js/markdown.js` — `parseFrontmatter()` (splits the `---` block from the body) and `formatDate()`, shared by both pages.
- `js/app.js` — homepage logic: fetches `posts/posts.json`, sorts by date, renders the list.
- `js/post.js` — post-page logic: reads the `post` query param, fetches `posts/<slug>.md`, parses frontmatter, and renders the body via `marked` (loaded from a CDN `<script>` tag in `post.html` — the one external dependency in the project).
- `css/style.css` — all styling, including the light/dark theme variables and mobile breakpoints.

To add a post: create `posts/<slug>.md` with frontmatter, then add a matching entry to `posts/posts.json`.

## Commands

No package manager or build step. Since `fetch()` of local files requires HTTP (not `file://`), serve the directory with any static server, e.g.:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`.
