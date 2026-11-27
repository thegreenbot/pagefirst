"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PREVIEW_SANDBOX,
  deferMedia,
  parseFromPreview,
  previewDocument,
  type ToPreview,
} from "@/lib/editor/preview-document";

type FrameRefs = {
  frame: { current: HTMLIFrameElement | null };
  ready: { current: boolean };
};

function post(refs: FrameRefs, message: ToPreview) {
  if (!refs.ready.current) return;
  refs.frame.current?.contentWindow?.postMessage(message, "*");
}

type Props = {
  /** The theme engine's edit-mode HTML for the current draft. */
  html: string;
  nonce: string;
  selectedId: string | null;
  /** Bumped when the editor wants the selected node focused in the page. */
  focusToken: number;
  onSelect: (id: string) => void;
  onText: (id: string, text: string) => void;
};

/**
 * Shows the draft in a sandboxed, opaque-origin iframe (see
 * lib/editor/preview-document.ts). The document is written once; later drafts
 * are posted to the bridge, which swaps the body without a reload.
 */
export function PreviewFrame({ html, nonce, selectedId, focusToken, onSelect, onText }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [initialDoc] = useState(() => previewDocument(html, nonce));
  // The HTML the frame shows now. Posting the same HTML again would swap the
  // body under the author's pointer for nothing.
  const shown = useRef(deferMedia(html));
  const [height, setHeight] = useState(480);
  const readyRef = useRef(false);
  const latest = useRef({ html, selectedId, onSelect, onText });
  latest.current = { html, selectedId, onSelect, onText };
  const media = useRef(new Map<string, Promise<Blob | null>>());
  const focusedToken = useRef(0);
  const refs = useRef<FrameRefs>({ frame: frameRef, ready: readyRef }).current;
  const showHtml = useCallback(
    (next: string) => {
      const deferred = deferMedia(next);
      if (!refs.ready.current || deferred === shown.current) return;
      shown.current = deferred;
      post(refs, { pf: 1, type: "render", html: deferred });
    },
    [refs],
  );

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = frameRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const message = parseFromPreview(event.data);
      if (!message) return;
      switch (message.type) {
        case "ready":
          readyRef.current = true;
          post(refs, { pf: 1, type: "hello" });
          showHtml(latest.current.html);
          post(refs, { pf: 1, type: "select", id: latest.current.selectedId });
          break;
        case "select":
          latest.current.onSelect(message.id);
          break;
        case "text":
          // The bridge drops any render it deferred while the author typed and
          // waits for a fresh one, so always answer, even when nothing changed.
          shown.current = "";
          latest.current.onText(message.id, message.text);
          setTimeout(() => showHtml(latest.current.html), 0);
          break;
        case "height":
          setHeight(Math.max(320, Math.ceil(message.height)));
          break;
        case "image": {
          const src = message.src;
          let bytes = media.current.get(src);
          if (!bytes) {
            bytes = fetch(src)
              .then((response) => (response.ok ? response.blob() : null))
              .catch(() => null);
            media.current.set(src, bytes);
          }
          void bytes.then((blob) => {
            if (blob) post(refs, { pf: 1, type: "image", src, blob });
          });
          break;
        }
      }
    }
    window.addEventListener("message", onMessage);
    // The server-rendered frame may have said "ready" before this listener existed.
    frameRef.current?.contentWindow?.postMessage({ pf: 1, type: "hello" } satisfies ToPreview, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [refs, showHtml]);

  useEffect(() => {
    showHtml(html);
  }, [showHtml, html]);

  useEffect(() => {
    const focus = focusToken !== focusedToken.current;
    focusedToken.current = focusToken;
    post(refs, { pf: 1, type: "select", id: selectedId, focus });
  }, [refs, selectedId, focusToken]);

  return (
    <iframe
      ref={frameRef}
      title="Page preview"
      sandbox={PREVIEW_SANDBOX}
      srcDoc={initialDoc}
      className="block w-full border border-rule bg-white"
      style={{ height }}
    />
  );
}
