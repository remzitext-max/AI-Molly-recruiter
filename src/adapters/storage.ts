import fs from "node:fs/promises";
import path from "node:path";
import type { DocumentStorage, IntegrationStatus } from "./types";

/** Private filesystem storage outside the web root. Keys are opaque random IDs. */
export class LocalPrivateStorage implements DocumentStorage {
  key = "local-private";
  constructor(private root: string) {}
  status(): IntegrationStatus {
    return { kind: "storage", provider: "Local private disk", state: "configured", isMock: false, detail: `Files stored outside the web root in ${this.root}. Use an encrypted volume or swap in S3-compatible storage for production.` };
  }
  private resolve(key: string) {
    if (!/^[a-zA-Z0-9/_-]+(\.[a-z0-9]+)?$/.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await fs.writeFile(p, data, { mode: 0o600, flag: "wx" });
  }
  async get(key: string) { return fs.readFile(this.resolve(key)); }
  async delete(key: string) { await fs.rm(this.resolve(key), { force: true }); }
}
