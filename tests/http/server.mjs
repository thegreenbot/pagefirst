// Starts the built app (`npm run build` first) with `next start` on a free
// port, with the fake Google preloaded. Returns a base URL and a stop function.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fake = path.join(root, "tests/http/fake-google.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** @param {{ google?: boolean, env?: Record<string, string> }} options google: true sets OAuth credentials, so the app leaves sample mode; env overrides variables. */
export async function startApp({ google = false, env: extraEnv = {} } = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(fake).slice(1, -1)}`.trim(),
    GOOGLE_CLIENT_ID: google ? "test-client-id" : "",
    GOOGLE_CLIENT_SECRET: google ? "test-client-secret" : "",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    PUBLISH_ALLOWLIST: "author@example.com",
    // Production sets APP_URL; without it `next start` reports a localhost origin.
    APP_URL: `http://127.0.0.1:${port}`,
    ...extraEnv,
  };
  const child = spawn(
    process.execPath,
    [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited early:\n${output}`);
    try {
      const res = await fetch(`${base}/api/pages`);
      if (res.status < 500) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`next start did not become ready:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return {
    base,
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** Collects Set-Cookie headers into a name → value map. */
export function cookiesFrom(res) {
  const jar = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const index = pair.indexOf("=");
    jar[pair.slice(0, index).trim()] = pair.slice(index + 1);
  }
  return jar;
}

export function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
