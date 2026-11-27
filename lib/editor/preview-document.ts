/**
 * The editor preview (#55). The theme engine's `mode: "edit"` output runs in an
 * iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, so it has an
 * opaque origin: theme code inside cannot read the editor's cookies, storage or
 * DOM. A small bridge script talks to the editor with postMessage, keyed by the
 * `data-pf-id` attributes the engine adds in edit mode.
 *
 * No Node imports: the editor builds this document in the browser.
 */

/** iframe sandbox tokens. Never add allow-same-origin: it would give theme code the app's origin. */
export const PREVIEW_SANDBOX = "allow-scripts";

const MEDIA_PATH = /^\/api\/media\/[A-Za-z0-9_-]{1,200}$/;

export function isMediaPath(value: unknown): value is string {
  return typeof value === "string" && MEDIA_PATH.test(value);
}

/** Messages from the preview to the editor. */
export type FromPreview =
  | { pf: 1; type: "ready" }
  | { pf: 1; type: "select"; id: string }
  | { pf: 1; type: "text"; id: string; text: string }
  | { pf: 1; type: "height"; height: number }
  | { pf: 1; type: "image"; src: string };

/** Messages from the editor to the preview. */
export type ToPreview =
  | { pf: 1; type: "hello" }
  | { pf: 1; type: "render"; html: string }
  | { pf: 1; type: "select"; id: string | null; focus?: boolean }
  | { pf: 1; type: "image"; src: string; blob: Blob };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Checks a message's shape. The caller must also check that it came from the preview frame. */
export function parseFromPreview(data: unknown): FromPreview | null {
  if (!isRecord(data) || data.pf !== 1) return null;
  switch (data.type) {
    case "ready":
      return { pf: 1, type: "ready" };
    case "select":
      return typeof data.id === "string" && data.id.length <= 200 ? { pf: 1, type: "select", id: data.id } : null;
    case "text":
      return typeof data.id === "string" && data.id.length <= 200 && typeof data.text === "string" && data.text.length <= 20_000
        ? { pf: 1, type: "text", id: data.id, text: data.text }
        : null;
    case "height":
      return typeof data.height === "number" && Number.isFinite(data.height)
        ? { pf: 1, type: "height", height: Math.max(0, Math.min(data.height, 100_000)) }
        : null;
    case "image":
      return isMediaPath(data.src) ? { pf: 1, type: "image", src: data.src } : null;
    default:
      return null;
  }
}

/**
 * Media is served with Cross-Origin-Resource-Policy: same-origin, which an
 * opaque-origin frame cannot load. The bridge asks the editor for the bytes
 * and shows them from a blob: URL instead.
 */
export function deferMedia(html: string): string {
  return html.replace(/<img src="(\/api\/media\/[^"]*)"/g, '<img data-pf-src="$1"');
}

/** Outlines and empty-node affordances. Editor only; never published. */
const EDITOR_STYLE = `[data-pf-id]{cursor:default}
[contenteditable]{cursor:text;outline:none}
[contenteditable]:empty{min-height:1.4em;outline:1px dashed #b9ad97}
[data-pf-id]:hover{outline:1px dashed #1a4738;outline-offset:2px}
[data-pf-selected]{outline:2px solid #1a4738!important;outline-offset:2px}
img[data-pf-src]:not([src]){min-height:6rem;background:#ebe4d6}`;

/** Runs inside the sandboxed frame. Plain ES2017, no imports. */
export const BRIDGE_SOURCE = `(() => {
  const host = window.parent;
  const post = (msg) => host.postMessage(Object.assign({ pf: 1 }, msg), "*");
  // Until the editor says hello its listener may not exist yet (the frame is
  // server-rendered and can load before the editor hydrates), so hold messages.
  let connected = false;
  const queue = [];
  const send = (msg) => (connected ? post(msg) : queue.push(msg));
  const blobs = new Map();
  let pending = null;
  let selected = null;
  const TEXT = /^(H1|H2|H3|H4|P)$/;
  const editable = (el) => !!el && el.nodeType === 1 && TEXT.test(el.tagName) && el.hasAttribute("data-pf-id");
  const height = () => send({ type: "height", height: document.documentElement.scrollHeight });
  const mark = () => {
    for (const el of document.querySelectorAll("[data-pf-selected]")) el.removeAttribute("data-pf-selected");
    if (!selected) return;
    for (const el of document.querySelectorAll("[data-pf-id]")) {
      if (el.getAttribute("data-pf-id") === selected) el.setAttribute("data-pf-selected", "");
    }
  };
  const decorate = () => {
    for (const el of document.querySelectorAll("[data-pf-id]")) {
      if (!editable(el)) continue;
      el.contentEditable = "plaintext-only";
      if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
      el.setAttribute("role", "textbox");
      el.setAttribute("aria-multiline", "true");
      el.setAttribute("aria-label", el.tagName.toLowerCase() + " text");
      el.spellcheck = true;
    }
    for (const img of document.querySelectorAll("img[data-pf-src]")) {
      const src = img.getAttribute("data-pf-src");
      if (blobs.has(src)) img.src = blobs.get(src);
      else send({ type: "image", src });
      img.addEventListener("load", height);
    }
    mark();
    height();
  };
  const apply = (html) => {
    const next = new DOMParser().parseFromString(html, "text/html");
    for (const style of document.head.querySelectorAll("style:not(#pf-editor-style)")) style.remove();
    for (const style of next.head.querySelectorAll("style")) document.head.appendChild(document.importNode(style, true));
    document.body.replaceChildren(...[...next.body.childNodes].map((node) => document.importNode(node, true)));
    decorate();
  };
  document.addEventListener("click", (event) => {
    const el = event.target instanceof Element ? event.target.closest("[data-pf-id]") : null;
    if (el) send({ type: "select", id: el.getAttribute("data-pf-id") });
  });
  document.addEventListener("focusout", (event) => {
    const el = event.target;
    if (!editable(el)) return;
    // The editor answers every text message with a fresh render, so an older deferred one is stale.
    pending = null;
    send({ type: "text", id: el.getAttribute("data-pf-id"), text: el.textContent || "" });
  });
  window.addEventListener("message", (event) => {
    if (event.source !== host) return;
    const data = event.data;
    if (!data || data.pf !== 1) return;
    if (data.type === "hello") {
      if (connected) return;
      connected = true;
      post({ type: "ready" });
      for (const msg of queue.splice(0)) post(msg);
    } else if (data.type === "render" && typeof data.html === "string") {
      // Never replace the node the author is typing in; apply once they leave it.
      if (editable(document.activeElement)) pending = data.html;
      else apply(data.html);
    } else if (data.type === "image" && typeof data.src === "string" && data.blob instanceof Blob) {
      const url = URL.createObjectURL(data.blob);
      blobs.set(data.src, url);
      for (const img of document.querySelectorAll("img[data-pf-src]")) {
        if (img.getAttribute("data-pf-src") === data.src) img.src = url;
      }
    } else if (data.type === "select") {
      selected = typeof data.id === "string" ? data.id : null;
      mark();
      if (data.focus && selected) {
        for (const el of document.querySelectorAll("[data-pf-id]")) {
          if (el.getAttribute("data-pf-id") === selected && editable(el)) { el.focus(); break; }
        }
      }
    }
  });
  window.addEventListener("resize", height);
  decorate();
  post({ type: "ready" });
})();`;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * CSP for the preview document. The frame also inherits the editor page's own
 * policy, so the bridge carries that page's nonce.
 */
export function previewCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src blob: data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Turns the engine's edit-mode HTML into the preview frame's document. */
export function previewDocument(html: string, nonce: string): string {
  const safeNonce = escapeAttribute(nonce);
  const head = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(previewCsp(nonce))}">
<style id="pf-editor-style">${EDITOR_STYLE}</style>`;
  const bridge = `<script nonce="${safeNonce}">${BRIDGE_SOURCE}</script>`;
  let out = deferMedia(html);
  out = out.includes("<head>") ? out.replace("<head>", () => `<head>\n${head}`) : `${head}\n${out}`;
  out = out.includes("</body>") ? out.replace("</body>", () => `${bridge}\n</body>`) : `${out}\n${bridge}`;
  return out;
}
