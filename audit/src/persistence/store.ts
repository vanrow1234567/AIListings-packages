import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { AuditRecord } from '../domain/types.ts';

/** Minimal JSON-file persistence: one file per audit. Suitable for an MVP. */
export class AuditStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private file(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid audit id');
    return path.join(this.root, `${id}.json`);
  }

  async save(record: AuditRecord): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.file(record.id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    await rename(tmp, target);
  }

  async get(id: string): Promise<AuditRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as AuditRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async list(): Promise<AuditRecord[]> {
    await mkdir(this.root, { recursive: true });
    const files = (await readdir(this.root)).filter((f) => f.endsWith('.json'));
    const records = await Promise.all(
      files.map(async (f) => JSON.parse(await readFile(path.join(this.root, f), 'utf8')) as AuditRecord),
    );
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
