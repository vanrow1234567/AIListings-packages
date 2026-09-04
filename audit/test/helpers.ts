import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditEngine, newAuditRecord } from '../src/audit/engine.ts';
import { MockChatGptProvider, textResponse, type MockOptions } from '../src/chatgpt/mockProvider.ts';
import { EvidenceStore } from '../src/evidence/capture.ts';
import { AuditStore } from '../src/persistence/store.ts';
import type { AuditRecord, AuditRequest, ChatGptResponse } from '../src/domain/types.ts';
import type { WebsiteSnapshot } from '../src/business/understand.ts';

export const SPP: AuditRequest = {
  business_name: 'SPP Roofing',
  website: 'https://www.spproofing.co.uk/',
  location: 'Southampton',
};

export const roofingSite: WebsiteSnapshot = {
  title: 'SPP Roofing | Roofers in Southampton',
  description: 'Roof repairs, flat roofs and guttering across Southampton and Hampshire.',
  headings: ['Roofing Services'],
  text: 'SPP Roofing provides roof repairs.',
};

/** Build a realistic rendered ChatGPT answer that lists businesses in bold. */
export function listResponse(intro: string, names: string[], extra = ''): ChatGptResponse {
  const items = names.map((n) => `<li><p><strong>${n}</strong> – well reviewed locally.</p></li>`).join('');
  const html = `<p>${intro}</p><ul>${items}</ul>${extra ? `<p>${extra}</p>` : ''}`;
  const text = `${intro}\n${names.map((n) => `${n} – well reviewed locally.`).join('\n')}${extra ? `\n${extra}` : ''}`;
  return { text, html, links: [] };
}

export const advice = textResponse(
  "A leak around the chimney is usually failed flashing or cracked mortar. Check the loft for staining, put a bucket down and avoid going on the roof yourself. It's rarely a full replacement. Would you like help finding someone to look at it?",
);

export interface RunResult {
  record: AuditRecord;
  provider: MockChatGptProvider;
  dir: string;
}

export async function runAudit(mock: MockOptions, request: AuditRequest = SPP): Promise<RunResult> {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ail-audit-'));
  const provider = new MockChatGptProvider(mock);
  const engine = new AuditEngine({
    provider,
    evidence: new EvidenceStore(path.join(dir, 'evidence')),
    store: new AuditStore(path.join(dir, 'audits')),
    fetcher: async () => roofingSite,
  });
  const record = newAuditRecord(request, provider.name);
  await engine.run(record);
  return { record, provider, dir };
}
