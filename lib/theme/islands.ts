/**
 * Block JavaScript as islands (#60). Browser-safe: no Node imports.
 *
 * A block that declares `js` in theme.json ships blocks/<name>/block.js as an
 * ES module. Its template marks the mount point with {% island %}; on a
 * published page that becomes <pf-island data-pf-src data-pf-load>. The
 * loader below is inlined only on pages that have an island. It imports the
 * module when the load strategy fires and calls its default export with the
 * <pf-island> element. No framework runtime is provided.
 */

/** Keeps the wrapper out of layout: the island's children lay out as if it were not there. */
export const ISLAND_CSS = "@layer reset{pf-island{display:contents}}";

/**
 * The inline loader. `visible` observes the island's children (a display:contents
 * element has no box of its own), `idle` waits for requestIdleCallback, and
 * `interaction` waits for the first pointer, touch or focus inside the island.
 */
export const ISLAND_LOADER = [
  "(()=>{",
  "const go=e=>{if(!e||e.pfMounted)return;e.pfMounted=1;",
  "import(e.dataset.pfSrc).then(m=>{if(typeof m.default==\"function\")m.default(e)}).catch(r=>console.error(r))};",
  "const io=\"IntersectionObserver\"in window&&new IntersectionObserver((es,o)=>{for(const x of es)if(x.isIntersecting){o.unobserve(x.target);go(x.target.closest(\"pf-island\"))}},{rootMargin:\"200px\"});",
  "for(const e of document.querySelectorAll(\"pf-island[data-pf-src]\")){const l=e.dataset.pfLoad;",
  "if(l==\"idle\")(window.requestIdleCallback||setTimeout)(()=>go(e));",
  "else if(l==\"interaction\")for(const t of[\"pointerover\",\"pointerdown\",\"touchstart\",\"focusin\"])e.addEventListener(t,()=>go(e),{once:!0,passive:!0});",
  "else if(io&&e.children.length)for(const c of e.children)io.observe(c);",
  "else go(e)}",
  "})();",
].join("");

/** The default per-page JS budget from the theme ADR, in bytes compressed. */
export const JS_BUDGET_BYTES = 15 * 1024;
