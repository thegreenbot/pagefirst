import type { DomainProvider, ProviderAdd, ProviderStatus } from "./provider";

/** An in-memory provider for tests and local development: nothing leaves the process. */
export function createFakeProvider(): DomainProvider & {
  states: Map<string, ProviderStatus>;
  removed: string[];
  set(ref: string, status: Partial<ProviderStatus>): void;
} {
  const states = new Map<string, ProviderStatus>();
  const removed: string[] = [];
  let next = 0;
  return {
    name: "fake",
    states,
    removed,
    set(ref, status) {
      const current = states.get(ref);
      if (!current) throw new Error(`unknown ref ${ref}`);
      states.set(ref, { ...current, ...status });
    },
    async add(hostname): Promise<ProviderAdd> {
      for (const [ref, status] of states) if (ref.endsWith(`:${hostname}`)) return { ref, ...status };
      const ref = `fake-${++next}:${hostname}`;
      const status: ProviderStatus = {
        state: "pending",
        message: "Waiting for DNS",
        records: [{ type: "CNAME", name: hostname, value: "domains.fake.test", purpose: "route" }],
      };
      states.set(ref, status);
      return { ref, ...status };
    },
    async status(ref) {
      const status = states.get(ref);
      if (!status) return { state: "error", message: "This domain is no longer set up.", records: [] };
      return status;
    },
    async remove(ref) {
      removed.push(ref);
      states.delete(ref);
    },
  };
}
