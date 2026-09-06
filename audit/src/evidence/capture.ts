import { mkdir, readFile } from 'node:fs/promises';
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

  /** Read one captured PNG as an image data URL for multimodal verification. */
  async dataUrlFromFile(file: string): Promise<string> {
    const root = path.resolve(this.root);
    const resolved = path.resolve(file);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Screenshot path is outside the evidence store.');
    }
    const bytes = await readFile(resolved);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }

  /** Resolve a stored public evidence path back to its owned file without accepting traversal. */
  async dataUrlForPublicPath(auditId: string, publicPath: string): Promise<string> {
    const prefix = `/evidence/${encodeURIComponent(auditId)}/`;
    if (!publicPath.startsWith(prefix)) throw new Error('Screenshot path does not belong to this audit.');
    const encoded = publicPath.slice(prefix.length);
    const file = decodeURIComponent(encoded);
    if (!file || path.basename(file) !== file || !file.toLowerCase().endsWith('.png')) {
      throw new Error('Invalid screenshot filename.');
    }
    return this.dataUrlFromFile(path.join(this.dir(auditId), file));
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

  /**
   * Capture the latest assistant response at readable resolution for multimodal QA.
   * The public report still uses the full-page screenshot above. If the provider
   * cannot crop the response, fall back to the full page rather than lose the witness.
   */
  async captureResponse(
    conversation: ChatGptConversation,
    auditId: string,
    label: string,
  ): Promise<{ path?: string; publicPath?: string; error?: string }> {
    const dir = this.dir(auditId);
    await mkdir(dir, { recursive: true });
    const file = `${label}-${Date.now()}.png`;
    const full = path.join(dir, file);
    try {
      if (conversation.screenshotResponse) {
        try {
          await conversation.screenshotResponse(full);
        } catch {
          await conversation.screenshot(full);
        }
      } else {
        await conversation.screenshot(full);
      }
      return { path: full, publicPath: this.publicPath(auditId, file) };
    } catch (err) {
      return { error: `Visual screenshot failed: ${(err as Error).message}` };
    }
  }
}
