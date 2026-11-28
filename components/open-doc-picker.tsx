"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type PickerConfig = { apiKey: string; appId: string; accessToken: string };
type PickerDoc = { id: string };
type PickerResponse = { action: string; docs?: PickerDoc[] };

// The slice of Google's Picker API used here; it has no published types.
type GooglePicker = {
  picker: {
    Action: { PICKED: string };
    ViewId: { DOCUMENTS: string };
    DocsView: new (viewId: string) => { setMode(mode: unknown): unknown };
    PickerBuilder: new () => {
      addView(view: unknown): unknown;
      setOAuthToken(token: string): unknown;
      setDeveloperKey(key: string): unknown;
      setAppId(id: string): unknown;
      setCallback(callback: (response: PickerResponse) => void): unknown;
      build(): { setVisible(visible: boolean): void };
    };
  };
};
declare global {
  interface Window {
    gapi?: { load(name: string, callback: () => void): void };
    google?: GooglePicker;
  }
}

let loading: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error("Could not load the Google Picker."));
    };
    script.onload = () => window.gapi!.load("picker", () => resolve());
    document.head.append(script);
  });
  return loading;
}

/**
 * Opens an existing Google Doc through the Google Picker (#15). Picking a Doc
 * is what grants this app `drive.file` access to that one file.
 */
export function OpenDocPicker() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "opening" | "error">("idle");
  const [message, setMessage] = useState("");

  async function open() {
    setState("opening");
    try {
      const response = await fetch("/api/google/picker", { cache: "no-store" });
      const config = (await response.json()) as PickerConfig & { error?: string };
      if (!response.ok) throw new Error(config.error ?? "Could not start the Google Picker.");
      await loadPicker();
      const { picker } = window.google!;
      const view = new picker.DocsView(picker.ViewId.DOCUMENTS);
      const built = new picker.PickerBuilder();
      built.addView(view);
      built.setOAuthToken(config.accessToken);
      built.setDeveloperKey(config.apiKey);
      built.setAppId(config.appId);
      built.setCallback((result) => {
        if (result.action === picker.Action.PICKED && result.docs?.[0]) router.push(`/edit/${encodeURIComponent(result.docs[0].id)}`);
        if (result.action !== "loaded") setState("idle");
      });
      built.build().setVisible(true);
      setState("idle");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open the Google Picker.");
      setState("error");
    }
  }

  return (
    <div className="mt-8">
      <button type="button" onClick={open} disabled={state === "opening"} className="border border-ink px-4 py-2 text-sm text-ink disabled:opacity-60">
        {state === "opening" ? "Opening…" : "Open a Google Doc"}
      </button>
      {state === "error" ? (
        <p role="alert" className="mt-2 text-sm text-ink-soft">
          {message}
        </p>
      ) : null}
    </div>
  );
}
