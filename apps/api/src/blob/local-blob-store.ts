import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlobStore } from "./blob-store.js";

/**
 * Filesystem BlobStore for local dev / the prototype. Files are sharded by the
 * first two chars of the key so one directory never holds millions of entries
 * (mirrors how an S3 prefix layout would shard). The reference we hand back is
 * `local://<key>`; the production S3 adapter would return `s3://bucket/<key>`.
 */
export class LocalBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {}

  private pathFor(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    const shard = safe.slice(0, 2) || "_";
    return join(this.rootDir, shard, `${safe}.json`);
  }

  async put(key: string, data: string): Promise<string> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, "utf8");
    return `local://${key}`;
  }

  async get(ref: string): Promise<string | null> {
    const key = ref.startsWith("local://") ? ref.slice("local://".length) : ref;
    try {
      return await readFile(this.pathFor(key), "utf8");
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {}
}
