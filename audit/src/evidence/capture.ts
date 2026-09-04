import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ChatGptConversation } from '../chatgpt/provider.ts';

/**
 * Stores screenshots under <root>/<auditId>/. A failed screenshot is recorded
 * as a warning and never fails the layer: the displayed text is still evidence.
 */
export class EvidenceStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  dir(auditId: string): string {
    return path.join(this.root, auditId);
  }

  /** Public URL path served by the HTTP server. */
  publicPath(auditId: string, file: string): string {
    return `/evidence/${encodeURIComponent(auditId)}/${encodeURIComponent(file)}`;
  }

  async capture(
    conversation: ChatGptConversation,
    auditId: string,
    label: string,
  ): Promise<{ path?: string; publicPath?: string; error?: string }> {
    const dir = this.dir(auditId);
    await mkdir(dir, { recursive: true });
    const file = `${label}-${Date.now()}.png`;
    const full = path.join(dir, file);
    try {
      await conversation.screenshot(full);
      return { path: full, publicPath: this.publicPath(auditId, file) };
    } catch (err) {
      return { error: `Screenshot failed: ${(err as Error).message}` };
    }
  }
}
