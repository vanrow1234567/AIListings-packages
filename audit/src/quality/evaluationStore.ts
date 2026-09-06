import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuditRecord, LayerEvidenceReconciliation, SemanticFinalReview } from '../domain/types.ts';

export class EvaluationStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private async write(auditId: string, label: string, payload: unknown): Promise<string> {
    const dir = path.join(this.root, auditId);
    await mkdir(dir, { recursive: true });
    const file = `${label}-${Date.now()}.json`;
    const full = path.join(dir, file);
    await writeFile(full, JSON.stringify(payload, null, 2), 'utf8');
    return full;
  }

  async saveLayerDispute(record: AuditRecord, reconciliation: LayerEvidenceReconciliation): Promise<string> {
    const layer = record.layers[reconciliation.layer];
    return this.write(record.id, `layer-${reconciliation.layer.toLowerCase()}-dispute`, {
      kind: 'LAYER_EVIDENCE_DISPUTE',
      createdAt: new Date().toISOString(),
      buildRef: process.env.AUDIT_BUILD_REF ?? null,
      auditId: record.id,
      leadId: record.request.lead_id ?? null,
      business: record.request.business_name,
      website: record.request.website,
      location: record.request.location,
      layer: reconciliation.layer,
      parser: {
        state: layer.state,
        prospectPresent: reconciliation.deterministicProspectPresent,
        businessesSurfaced: layer.businessesSurfaced,
        competitorsMentioned: layer.competitorsMentioned,
        prospectMatchEvidence: layer.prospectMatchEvidence ?? [],
        identityResolutions: layer.identityResolutions ?? [],
      },
      reconciliation,
      turns: layer.turns.map((t) => ({
        index: t.index,
        prompt: t.prompt,
        responseText: t.response.text,
        responseHtml: t.response.html,
        links: t.response.links,
        screenshotPath: t.screenshotPath ?? null,
        visualReview: t.visualReview ?? null,
        visualReviewError: t.visualReviewError ?? null,
      })),
    });
  }

  async saveFinalRejection(
    record: AuditRecord,
    review: SemanticFinalReview,
    candidateOutreach: string,
  ): Promise<string> {
    return this.write(record.id, 'final-rejection', {
      kind: 'FINAL_SEMANTIC_REJECTION',
      createdAt: new Date().toISOString(),
      buildRef: process.env.AUDIT_BUILD_REF ?? null,
      auditId: record.id,
      leadId: record.request.lead_id ?? null,
      business: record.request.business_name,
      website: record.request.website,
      location: record.request.location,
      understanding: record.understanding ?? null,
      layers: record.layers,
      topCompetitors: record.topCompetitors,
      candidateOutreach,
      quality: record.quality ?? null,
      finalReview: review,
    });
  }
}
