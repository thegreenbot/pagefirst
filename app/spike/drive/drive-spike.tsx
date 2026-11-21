"use client";

import { useState } from "react";

type Entry = { at: string; label: string; payload: unknown };

type PickerGlobal = {
  gapi?: { load: (name: string, cb: () => void) => void };
  google?: {
    picker: {
      PickerBuilder: new () => PickerBuilder;
      DocsView: new (viewId?: unknown) => DocsView;
      ViewId: { DOCS: unknown; FOLDERS: unknown; DOCUMENTS: unknown };
      Action: { PICKED: string };
      Feature: { MULTISELECT_ENABLED: unknown };
    };
  };
};
type DocsView = {
  setIncludeFolders: (v: boolean) => DocsView;
  setSelectFolderEnabled: (v: boolean) => DocsView;
  setParent?: (id: string) => DocsView;
};
type PickerBuilder = {
  addView: (v: DocsView) => PickerBuilder;
  setOAuthToken: (t: string) => PickerBuilder;
  setDeveloperKey: (k: string) => PickerBuilder;
  setAppId: (id: string) => PickerBuilder;
  enableFeature: (f: unknown) => PickerBuilder;
  setCallback: (cb: (data: { action: string; docs?: { id: string; name: string; mimeType: string }[] }) => void) => PickerBuilder;
  build: () => { setVisible: (v: boolean) => void };
};

function loadPickerScript(): Promise<void> {
  const w = window as unknown as PickerGlobal;
  if (w.google?.picker) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.onload = () => w.gapi?.load("picker", () => resolve());
    script.onerror = () => reject(new Error("Could not load Google API script"));
    document.head.appendChild(script);
  });
}

export function DriveSpike() {
  const [rootId, setRootId] = useState("");
  const [docId, setDocId] = useState("");
  const [name, setName] = useState("pagefirst-spike");
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);

  const record = (label: string, payload: unknown) =>
    setLog((prev) => [{ at: new Date().toLocaleTimeString(), label, payload }, ...prev]);

  async function run(label: string, fn: () => Promise<Response>) {
    setBusy(true);
    try {
      const res = await fn();
      record(label, { http: res.status, ...(await res.json()) });
    } catch (err) {
      record(label, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const probe = () => {
    const params = new URLSearchParams();
    if (rootId) params.set("root", rootId);
    if (docId) params.set("doc", docId);
    return run("probe", () => fetch(`/api/spike/drive?${params}`));
  };

  const post = (label: string, body: object) =>
    run(label, () =>
      fetch("/api/spike/drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  async function pick(kind: "folder" | "doc") {
    setBusy(true);
    try {
      const res = await fetch("/api/spike/token");
      const cfg = (await res.json()) as { token?: string; apiKey?: string; appId?: string; error?: string };
      if (!cfg.token) throw new Error(cfg.error ?? "No token");
      if (!cfg.apiKey || !cfg.appId) throw new Error("Set SPIKE_PICKER_API_KEY and SPIKE_PICKER_APP_ID");
      await loadPickerScript();
      const gp = (window as unknown as PickerGlobal).google!.picker;
      const view =
        kind === "folder"
          ? new gp.DocsView(gp.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true)
          : new gp.DocsView(gp.ViewId.DOCUMENTS).setIncludeFolders(true);
      new gp.PickerBuilder()
        .addView(view)
        .setOAuthToken(cfg.token)
        .setDeveloperKey(cfg.apiKey)
        .setAppId(cfg.appId)
        .setCallback((data) => {
          if (data.action !== gp.Action.PICKED || !data.docs?.[0]) return;
          const picked = data.docs[0];
          record(`picked ${kind}`, picked);
          if (kind === "folder") setRootId(picked.id);
          else setDocId(picked.id);
        })
        .build()
        .setVisible(true);
    } catch (err) {
      record(`pick ${kind}`, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const field = "border border-black/30 rounded px-2 py-1 font-mono text-sm w-full";
  const button = "border border-black/40 rounded px-3 py-1 text-sm disabled:opacity-40";

  return (
    <main className="max-w-3xl mx-auto p-6 space-y-4">
      <h1 className="text-xl font-semibold">drive.file access spike</h1>
      <p className="text-sm">
        Not product code. Protocol: <code>docs/spikes/drive-file-access.md</code>.{" "}
        <a className="underline" href="/api/auth/google">Sign in / switch account</a>
      </p>
      <form method="post" action="/api/auth/logout">
        <button className="underline text-sm" type="submit">Sign out</button>
      </form>

      <label className="block text-sm">Root folder id
        <input className={field} value={rootId} onChange={(e) => setRootId(e.target.value.trim())} />
      </label>
      <label className="block text-sm">Doc id
        <input className={field} value={docId} onChange={(e) => setDocId(e.target.value.trim())} />
      </label>
      <label className="block text-sm">Name for created items
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy} onClick={probe}>Run probes</button>
        <button className={button} disabled={busy || !docId} onClick={() => post("write probe", { action: "write", docId })}>Write probe on doc</button>
        <button className={button} disabled={busy} onClick={() => post("create root folder", { action: "create-folder", name })}>Create root folder</button>
        <button className={button} disabled={busy || !rootId} onClick={() => post("create subfolder", { action: "create-folder", name, parentId: rootId })}>Create folder in root</button>
        <button className={button} disabled={busy || !rootId} onClick={() => post("create doc", { action: "create-doc", name, parentId: rootId })}>Create doc in root</button>
        <button className={button} disabled={busy} onClick={() => pick("folder")}>Picker: folder</button>
        <button className={button} disabled={busy} onClick={() => pick("doc")}>Picker: doc</button>
      </div>

      <ol className="space-y-2">
        {log.map((entry, i) => (
          <li key={i} className="border border-black/10 rounded p-2">
            <div className="text-xs opacity-60">{entry.at} · {entry.label}</div>
            <pre className="text-xs overflow-x-auto">{JSON.stringify(entry.payload, null, 2)}</pre>
          </li>
        ))}
      </ol>
    </main>
  );
}
