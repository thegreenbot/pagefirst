"use client";

import { useEffect, useState } from "react";

type Metric = { p75: number; samples: number; good: boolean };
type Report = {
  enabled: boolean;
  days: number;
  collector: boolean;
  targets: { lcp: number; cls: number; inp: number };
  pages: { path: string; metrics: Partial<Record<"lcp" | "cls" | "inp", Metric>> }[];
};

const buttonClass = "border border-rule bg-paper px-3 py-1.5 text-sm text-ink disabled:opacity-50";

function cell(metric: Metric | undefined, kind: "lcp" | "cls" | "inp") {
  if (!metric) return <span className="text-ink-soft">no data</span>;
  const text = kind === "cls" ? metric.p75.toFixed(2) : `${(metric.p75 / (kind === "lcp" ? 1000 : 1)).toFixed(kind === "lcp" ? 1 : 0)}${kind === "lcp" ? " s" : " ms"}`;
  return (
    <span>
      {text} <span className="text-ink-soft">({metric.good ? "good" : "needs work"}, {metric.samples} visits)</span>
    </span>
  );
}

export function SpeedReport() {
  const [report, setReport] = useState<Report | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/site/speed", { cache: "no-store" });
    const data = (await response.json()) as Report & { error?: string };
    if (!response.ok) setMessage(data.error ?? "Could not load the speed report.");
    else setReport(data);
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/site/speed", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) setMessage(data.error ?? "Could not change the setting.");
      else {
        setMessage(enabled ? "Turned on. Pages carry the beacon from their next publish." : "Turned off. Pages drop the beacon from their next publish.");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-4xl px-4 py-6">
      <h1 className="text-xl font-medium text-ink">Field speed</h1>
      <p className="py-2 text-sm text-ink-soft">
        Real visitors’ loading speed (LCP), layout stability (CLS) and responsiveness (INP), as the 75th percentile over the last {report?.days ?? 7} days. Targets: LCP 2.5 s, CLS 0.1, INP 200 ms.
        When this is on, published pages carry a small script (under 1 KB) that sends those three numbers, the page path and your site id to this app once per visit. It sets no cookie and sends no identifier. Samples are deleted after 30 days. When it is off, published pages ship no script.
      </p>
      {message ? <p role="status" className="py-1 text-sm text-ink">{message}</p> : null}
      {report ? (
        <>
          <button type="button" className={buttonClass} disabled={busy || (!report.enabled && !report.collector)} onClick={() => void toggle(!report.enabled)}>
            {report.enabled ? "Turn off the speed beacon" : "Turn on the speed beacon"}
          </button>
          {!report.collector && !report.enabled ? <p className="py-1 text-sm text-ink-soft">This instance has no public https address configured, so the beacon can’t be enabled.</p> : null}
          {report.enabled && report.pages.length === 0 ? <p className="py-3 text-sm text-ink-soft">No visits recorded yet. Republish your pages, then check back after a day of traffic.</p> : null}
          {report.pages.length > 0 ? (
            <table className="mt-4 w-full text-left text-sm">
              <thead>
                <tr className="border-b border-rule text-ink-soft">
                  <th className="py-1 pr-3 font-normal">Page</th>
                  <th className="py-1 pr-3 font-normal">LCP</th>
                  <th className="py-1 pr-3 font-normal">CLS</th>
                  <th className="py-1 font-normal">INP</th>
                </tr>
              </thead>
              <tbody>
                {report.pages.map((page) => (
                  <tr key={page.path} className="border-b border-rule align-top">
                    <td className="py-1 pr-3 break-all text-ink">{page.path}</td>
                    <td className="py-1 pr-3">{cell(page.metrics.lcp, "lcp")}</td>
                    <td className="py-1 pr-3">{cell(page.metrics.cls, "cls")}</td>
                    <td className="py-1">{cell(page.metrics.inp, "inp")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
