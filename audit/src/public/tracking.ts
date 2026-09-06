import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuditRecord, PublicReport } from '../domain/types.ts';

/** 256 bits of randomness, URL-safe, no business or storage information. */
export function issuePublicToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Per-render session nonce embedded in the page; an engagement event must quote one the server issued. */
export function issueSessionNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** Bound the stored nonce lists so a scanner hammering the URL cannot grow the record without limit. */
const MAX_ISSUED_SESSIONS = 500;
const MAX_ENGAGED_SESSIONS = 2000;

/**
 * Give a COMPLETE audit a public report (idempotent). Never issues one for an
 * incomplete / errored / sign-in-required audit. If a previously complete audit
 * is re-analysed to a non-complete state its report stays stored for its tracking
 * history but is no longer served (see isPubliclyAvailable).
 */
function semanticReleaseApproved(record: AuditRecord): boolean {
  if (record.quality?.required !== true) return true;
  return (
    record.quality.preflight?.approved === true &&
    (record.quality.preflight.confidence ?? 0) >= 0.9 &&
    record.quality.final?.approved === true &&
    (record.quality.final.confidence ?? 0) >= 0.9
  );
}

export function ensurePublicReport(record: AuditRecord, now: () => Date = () => new Date()): PublicReport | undefined {
  if (record.status !== 'COMPLETE' || !semanticReleaseApproved(record)) return undefined;
  if (!record.publicReport) {
    record.publicReport = {
      token: issuePublicToken(),
      createdAt: now().toISOString(),
      pageRequestCount: 0,
      engagedViewCount: 0,
      ctaClickCount: 0,
      issuedSessions: [],
      engagedSessions: [],
    };
  }
  return record.publicReport;
}

export function isPubliclyAvailable(record: AuditRecord | undefined): record is AuditRecord & { publicReport: PublicReport } {
  return !!record && record.status === 'COMPLETE' && semanticReleaseApproved(record) && !!record.publicReport;
}

/**
 * A GET of the report. Counts every request (bots included) for diagnostics and
 * issues the session nonce the page will quote when it reports genuine engagement.
 */
export function recordPageRequest(report: PublicReport, now: () => Date = () => new Date()): string {
  const iso = now().toISOString();
  if (!report.firstRequestedAt) report.firstRequestedAt = iso;
  report.lastRequestedAt = iso;
  report.pageRequestCount = (report.pageRequestCount ?? 0) + 1; // records stored before this field existed
  const nonce = issueSessionNonce();
  report.issuedSessions = [...(report.issuedSessions ?? []), nonce].slice(-MAX_ISSUED_SESSIONS);
  return nonce;
}

export type EngagementOutcome = 'counted' | 'duplicate' | 'unknown_session';

/**
 * The rendered page reported ~2s of visible time. Counts once per issued session:
 * a nonce the server never issued is rejected, one that already counted is ignored.
 */
export function recordEngagement(report: PublicReport, session: string, now: () => Date = () => new Date()): EngagementOutcome {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(session)) return 'unknown_session';
  const engaged = report.engagedSessions ?? [];
  if (engaged.some((s) => safeEqual(s, session))) return 'duplicate';
  const issued = report.issuedSessions ?? [];
  const index = issued.findIndex((s) => safeEqual(s, session));
  if (index === -1) return 'unknown_session';
  const iso = now().toISOString();
  if (!report.firstEngagedAt) report.firstEngagedAt = iso;
  report.lastEngagedAt = iso;
  report.engagedViewCount = (report.engagedViewCount ?? 0) + 1;
  report.issuedSessions = issued.filter((_, i) => i !== index);
  report.engagedSessions = [...engaged, session].slice(-MAX_ENGAGED_SESSIONS);
  return 'counted';
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function recordCtaClick(report: PublicReport, now: () => Date = () => new Date()): void {
  const iso = now().toISOString();
  if (!report.ctaClickedAt) report.ctaClickedAt = iso;
  report.ctaClickCount = (report.ctaClickCount ?? 0) + 1;
}

export function publicPath(token: string): string {
  return `/a/${token}`;
}

export function publicUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}${publicPath(token)}`;
}

/**
 * Tracking state for the future CRM push. Internal only. CRM logic must key off
 * firstEngagedAt / engagedViewCount (confirmed human engagement), never pageRequestCount.
 */
export function trackingState(record: AuditRecord, baseUrl: string) {
  const r = record.publicReport;
  return {
    lead_id: record.request.lead_id ?? null,
    business_name: record.request.business_name,
    status: record.status,
    publicUrl: isPubliclyAvailable(record) ? publicUrl(baseUrl, record.publicReport.token) : null,
    createdAt: r?.createdAt ?? null,
    pageRequestCount: r?.pageRequestCount ?? 0,
    firstRequestedAt: r?.firstRequestedAt ?? null,
    lastRequestedAt: r?.lastRequestedAt ?? null,
    firstEngagedAt: r?.firstEngagedAt ?? null,
    lastEngagedAt: r?.lastEngagedAt ?? null,
    engagedViewCount: r?.engagedViewCount ?? 0,
    ctaClickedAt: r?.ctaClickedAt ?? null,
    ctaClickCount: r?.ctaClickCount ?? 0,
  };
}
