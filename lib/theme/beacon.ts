/**
 * The opt-in speed beacon (#70): an inline script that reports a visit's LCP,
 * CLS and INP to the app's own collector, once, when the page is hidden. It sets
 * no cookie and sends no identifier: just the site, the path and three numbers.
 * Pages without it ship no script. No Node imports: the engine runs in browsers too.
 *
 * INP here is the slowest interaction seen (`event` timings with an
 * interaction id), the same quantity the web-vitals library reports for visits
 * with fewer than 50 interactions.
 */
export type Beacon = { endpoint: string; site: string; path: string };

const safe = (value: string) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export function beaconScript(beacon: Beacon): string {
  return [
    "(()=>{",
    `const E=${safe(beacon.endpoint)},S=${safe(beacon.site)},P=${safe(beacon.path)},d={};`,
    "const o=(t,f,x)=>{try{new PerformanceObserver(l=>f(l.getEntries())).observe(Object.assign({type:t,buffered:!0},x))}catch(e){}};",
    'o("largest-contentful-paint",e=>{d.lcp=e[e.length-1].startTime});',
    'let c=0;o("layout-shift",e=>{for(const x of e)x.hadRecentInput||(c+=x.value);d.cls=c});',
    'let i=0;o("event",e=>{for(const x of e)if(x.interactionId&&x.duration>i){i=x.duration;d.inp=i}},{durationThreshold:40});',
    "let sent=0;const f=()=>{if(sent||!Object.keys(d).length)return;sent=1;navigator.sendBeacon(E,JSON.stringify({site:S,path:P,...d}))};",
    'addEventListener("visibilitychange",()=>{document.visibilityState=="hidden"&&f()});addEventListener("pagehide",f);',
    "})();",
  ].join("");
}

/** The field targets a visit counts as good against (Core Web Vitals). */
export const FIELD_TARGETS = { lcp: 2500, cls: 0.1, inp: 200 } as const;
export type VitalMetric = keyof typeof FIELD_TARGETS;
export const VITAL_METRICS = ["lcp", "cls", "inp"] as const;
