import { randomBytes } from 'node:crypto';
import type { AuditRecord, PublicReport } from '../domain/types.ts';

/** 256 bits of randomness, URL-safe, no business or storage information. */
export function issuePublicToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Give a COMPLETE audit a public report (idempotent). Never issues one for an
 * incomplete / errored / sign-in-required audit. If a previously complete audit
 * is re-analysed to a non-complete state its report stays stored for its tracking
 * history but is no longer served (see isPubliclyAvailable).
 */
export function ensurePublicReport(record: AuditRecord, now: () => Date = () => new Date()): PublicReport | undefined {
  if (record.status !== 'COMPLETE') return undefined;
  if (!record.publicReport) {
    record.publicReport = { token: issuePublicToken(), createdAt: now().toISOString(), viewCount: 0, ctaClickCount: 0 };
  }
  return record.publicReport;
}

export function isPubliclyAvailable(record: AuditRecord | undefined): record is AuditRecord & { publicReport: PublicReport } {
  return !!record && record.status === 'COMPLETE' && !!record.publicReport;
}

export function recordView(report: PublicReport, now: () => Date = () => new Date()): void {
  const iso = now().toISOString();
  if (!report.firstViewedAt) report.firstViewedAt = iso;
  report.lastViewedAt = iso;
  report.viewCount += 1;
}

export function recordCtaClick(report: PublicReport, now: () => Date = () => new Date()): void {
  const iso = now().toISOString();
  if (!report.ctaClickedAt) report.ctaClickedAt = iso;
  report.ctaClickCount += 1;
}

export function publicPath(token: string): string {
  return `/a/${token}`;
}

export function publicUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}${publicPath(token)}`;
}

/** Tracking state for the future CRM push. Internal only. */
export function trackingState(record: AuditRecord, baseUrl: string) {
  const r = record.publicReport;
  return {
    lead_id: record.request.lead_id ?? null,
    business_name: record.request.business_name,
    status: record.status,
    publicUrl: isPubliclyAvailable(record) ? publicUrl(baseUrl, record.publicReport.token) : null,
    createdAt: r?.createdAt ?? null,
    firstViewedAt: r?.firstViewedAt ?? null,
    lastViewedAt: r?.lastViewedAt ?? null,
    viewCount: r?.viewCount ?? 0,
    ctaClickedAt: r?.ctaClickedAt ?? null,
    ctaClickCount: r?.ctaClickCount ?? 0,
  };
}
