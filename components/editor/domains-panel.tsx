"use client";

import { useEffect, useState } from "react";

type Domain = { id: string; hostname: string; status: "pending" | "verifying" | "active" | "error" | "removed"; lastError: string | null };
type DnsRecord = { type: string; name: string; value: string };

const LABEL: Record<Domain["status"], string> = {
  pending: "Waiting for DNS",
  verifying: "Verifying",
  active: "Live",
  error: "Needs attention",
  removed: "Removed",
};

async function call(url: string, init?: RequestInit): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const response = await fetch(url, init);
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, data };
  } catch {
    return { ok: false, data: { error: "Couldn't reach the server." } };
  }
}

/** Custom domains for the published site (#188): add one, see the DNS records to create, check, remove. */
export function DomainsPanel() {
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [records, setRecords] = useState<Record<string, DnsRecord[]>>({});
  const [hostname, setHostname] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const { ok, data } = await call("/api/site/domains");
    if (ok && Array.isArray(data.domains)) setDomains(data.domains as Domain[]);
  }

  useEffect(() => {
    void load();
  }, []);

  function remember(view: unknown) {
    if (typeof view !== "object" || view === null) return;
    const { domain, records: list } = view as { domain?: Domain; records?: DnsRecord[] };
    if (domain && Array.isArray(list)) setRecords((current) => ({ ...current, [domain.id]: list }));
  }

  async function run(action: () => Promise<{ ok: boolean; data: Record<string, unknown> }>, done = "") {
    setBusy(true);
    setMessage("");
    const { ok, data } = await action();
    setBusy(false);
    if (!ok) {
      setMessage(typeof data.error === "string" ? data.error : "That didn't work.");
      return false;
    }
    remember(data);
    if (done) setMessage(done);
    await load();
    return true;
  }

  async function add() {
    const value = hostname.trim();
    if (!value) return;
    if (await run(() => call("/api/site/domains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostname: value }) }))) setHostname("");
  }

  const live = (domains ?? []).filter((domain) => domain.status !== "removed");

  return (
    <details className="mt-6 border border-rule">
      <summary className="cursor-pointer bg-paper-2 px-4 py-3 text-sm text-ink">Custom domain</summary>
      <div className="grid gap-3 border-t border-rule px-4 py-4 text-sm text-ink" data-testid="domains-panel">
        {domains === null ? <p className="text-ink-soft">Loading…</p> : null}
        {live.map((domain) => (
          <div key={domain.id} className="grid gap-1 border border-rule px-3 py-2">
            <p className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{domain.hostname}</span>
              <span className="text-xs text-ink-soft">{LABEL[domain.status]}</span>
            </p>
            {domain.lastError && domain.status !== "active" ? <p className="text-xs text-ink-soft">{domain.lastError}</p> : null}
            {(records[domain.id] ?? []).length > 0 ? (
              <ul className="grid gap-1 text-xs">
                {(records[domain.id] ?? []).map((record) => (
                  <li key={`${record.type}-${record.name}`}>
                    Add a {record.type} record: <code className="break-all">{record.name}</code> → <code className="break-all">{record.value}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="flex gap-4 text-xs">
              {domain.status !== "active" ? (
                <button type="button" disabled={busy} className="underline underline-offset-2" onClick={() => void run(() => call(`/api/site/domains/${domain.id}/check`, { method: "POST" }))}>
                  Check now
                </button>
              ) : null}
              <button type="button" disabled={busy} className="underline underline-offset-2" onClick={() => void run(() => call(`/api/site/domains/${domain.id}`, { method: "DELETE" }), "Domain removed.")}>
                Remove
              </button>
            </p>
          </div>
        ))}
        <label className="block">
          Add a domain
          <input
            type="text"
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="www.example.com"
            className="mt-1 block w-full border border-rule bg-paper px-2 py-1"
          />
        </label>
        <p className="text-xs text-ink-soft">Use a subdomain such as www.example.com. Point it at us with the DNS record shown after you add it.</p>
        <button type="button" disabled={busy || !hostname.trim()} onClick={() => void add()} className="justify-self-start border border-rule px-3 py-1 disabled:opacity-50">
          Add domain
        </button>
        {message ? <p role="status" className="text-xs text-ink-soft">{message}</p> : null}
      </div>
    </details>
  );
}
