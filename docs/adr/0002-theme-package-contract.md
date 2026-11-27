# ADR 0002: Theme package contract and Liquid render API

- Status: accepted
- Date: 2026-11-27
- Issue: #53, part of epic #52

## Context

`lib/page/render.ts` builds the published HTML by string concatenation with one hardcoded stylesheet, and the editor (`components/editor/page-editor.tsx`) renders its own React markup. A site cannot change its design without a product change, and the editor preview can drift from the published page.

Decisions already made for the theme system:

- Every theme, first-party included, is written in Liquid. Themes never run code on our servers.
- The Google Doc holds content only. A site's theme, tokens, settings, page templates and section styles are stored by the app (#56).
- Images are turned into renditions at publish time (#61).
- Brand tokens are included on every plan. Custom CSS and template overrides are paid on hosted plans (#65).

## Decision

### 1. A theme is a declarative package

```
themes/<name>/
  theme.json                 manifest, validated against lib/theme/theme.schema.json
  layouts/<template>.liquid  one file per page template; "page" is required
  partials/*.liquid          shared fragments, used with {% render %}
  blocks/<block>/
    block.liquid             markup for one block
    block.css                optional, shipped only on pages that use the block
    block.js                 optional ES module, mounted as an island (#60)
  styles/base.css            reset and base typography, in @layer theme
  styles/tokens.json         design tokens and their defaults (#57)
  assets/                    fonts and static images, served from the site's origin
  fixtures/                  sample pages used by tests and CI budgets (#58)
```

Nothing outside the package directory can be read. There is no build step and no server-side theme code.

### 2. The manifest, `theme.json`

The JSON Schema at `lib/theme/theme.schema.json` is the source of truth. In short:

| Field | Meaning |
| --- | --- |
| `name`, `version` | Package name (`@scope/name`) and semver version. |
| `engine` | The render API major version the theme targets. This ADR defines engine `1`. |
| `templates` | Page templates the editor offers. Each maps to `layouts/<name>.liquid`. `page` is required. |
| `blocks` | The block vocabulary authors can use in the Doc: each block's options, its JS load strategy (`visible`, `idle` or `interaction`), and an optional row and column shape. |
| `sectionStyles` | Section style names the editor offers. |
| `settings` | Theme settings shown as a form in the editor: `id`, `type` (`text`, `boolean`, `select`, `color`, `number`), `label`, `default`, and `options` for selects. |
| `permissions` | Origins a theme may contact (`connect`), load images from (`img`) or frame (`frame`). These feed the generated CSP (#63). Empty by default. |
| `integrations` | Named integrations the theme supports (for example `analytics`). Their origins are added to the CSP only when the site enables them. |
| `budgets` | Optional overrides of the CI performance budgets (#58). They can only tighten a budget. |

Unknown top-level fields are rejected so typos fail fast.

### 3. What a template receives

All values are read-only plain data. Templates never see Drive ids, tokens, cookies or request data.

| Variable | Contents |
| --- | --- |
| `page` | `title`, `description`, `path`, `template`, `sections` (each: `id`, `style`, `index`, `children`). Children are nodes: `kind` (`prose` or `block`), and either `tag`, `text`, `items`, `image` for prose, or a block. |
| `site` | `name`, `url`, `lang`. |
| `theme` | `name`, `version`, resolved `tokens` and `settings` (theme defaults merged with the site's config). |
| `block` | Only inside `blocks/<name>/block.liquid`: `name`, `options`, `rows` (rows of cells, each cell a list of prose nodes), `index` (position in its section), `section` (section index), `aboveFold` (true for blocks in the first section), `declared`. |
| `mode` | `edit` or `publish`. Themes should not branch on it; it exists for the engine's own tags. |

### 4. Tags and filters Pagefirst provides

| Tag or filter | Behaviour |
| --- | --- |
| `{% pf_head %}` | Emits the engine-managed head: charset, CSP `<meta>`, title, description, the page's CSS (inlined or deferred, #59), preloads (#62, #63). Required in every layout. |
| `{% pf_foot %}` | Emits engine-managed markup just before `</body>`: the deferred stylesheet link (#59) and, later, the island loader (#60). If a layout leaves it out, the engine inserts it before `</body>`. |
| `{% pf_node node %}` | Renders one node: prose through `partials/prose.liquid` if the theme has it, else the built-in prose markup; blocks through `blocks/<name>/block.liquid`. |
| `{% pf_id node %}` | Emits ` data-pf-id="..."` in edit mode and nothing in publish mode. Put it on the root element of every block and prose node so the editor can target it. |
| `{% image node %}` | Emits an `<img>` with `alt`, `width`, `height`, `srcset` and `sizes`, with eager loading and `fetchpriority="high"` for the first image above the fold and lazy loading for the rest (#61). |
| `{% island %}...{% endisland %}` | Marks where a block's JS mounts (#60). Ignored for blocks without `block.js`. |
| `classes` filter | Joins a list of tokens into a safe `class` value. |

Output escaping is on by default (`outputEscape: "escape"`), and the `raw` filter is removed. Doc text can never become markup. Only the engine's own tags emit HTML.

### 5. Sandbox limits

The engine runs LiquidJS with:

- An in-memory file system holding only the package's `.liquid` files. `{% include %}` and `{% layout %}` are disabled, `{% render %}` resolves only inside `partials/`, and paths with `..` or a leading `/` are refused.
- No access to the file system, network, environment or globals. `ownPropertyOnly: true` so templates cannot reach prototype members.
- `strictFilters: true`, so an unknown filter is a render error rather than silent output.
- Limits per page render: parse limit 1 MB of template source, render time 500 ms, memory limit for loops and strings, and 2 MB of HTML output. A theme that hits a limit fails the publish with a message that names the template.

### 6. Blocks a theme does not declare

A Doc can name a block the active theme does not declare, for example after a theme change. The engine renders it with the plain fallback, `<div class="{name} {options}">` with one `<div>` per cell, which matches the EDS shape and the current publish output. Publish still succeeds and reports the block in its warnings. The editor marks the block with a "not in this theme" badge. Unknown options on a declared block are dropped from the class list and reported the same way.

### 7. Render modes

The render function takes `mode: "edit" | "publish"`. The only difference is that edit mode adds `data-pf-id` attributes through `{% pf_id %}`. The editor shows edit output in a sandboxed iframe (#55), and a test checks that edit and publish output are identical once those attributes are removed.

### 8. Page CSS (#59)

The page gets `styles/base.css` plus the `block.css` of each declared block on the page, minified, with selectors for declared options the page does not use removed. If that is 10 KB or less compressed, it is all inlined in one `<style>`. Otherwise base and first-section block CSS are inlined, and the rest is one content-addressed file, `/assets/pf/<hash>.css`, shared by pages with the same block set. That file is linked at the end of `<body>` rather than swapped from `media="print"` with an `onload` handler, so published pages keep `script-src 'none'`. The CSP then allows `style-src 'self'` as well as the inline style's hash. The editor preview always inlines everything.

## Consequences

- `render.ts` keeps only orchestration; markup and styles move to `themes/default` (#54).
- A theme cannot ship server code, read secrets or put Doc text into raw HTML, which keeps the published page's CSP strict.
- Adding a tag, filter or template variable is an engine change. Breaking changes bump `engine` to `2`, and the engine keeps rendering engine `1` themes until they are migrated.
- Themes cannot run arbitrary build tools. Sass, PostCSS plugins or bundlers would have to run before a theme is published to the registry (#64), not at render time.

## Alternatives considered

- **React or JSX themes.** Expressive, but a theme would be server code with full Node access, which rules out third-party themes without a separate sandbox runtime. Rejected.
- **Handlebars or Mustache.** Safe, but too limited for layout logic, and less familiar to theme authors than Liquid, which Shopify and Jekyll authors already know.
- **Only CSS themes over a fixed markup.** Simplest, but blocks such as cards and carousels need markup changes. Kept as the floor: tokens and custom CSS work without touching templates.
