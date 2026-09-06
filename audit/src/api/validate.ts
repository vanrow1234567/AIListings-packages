import type { AuditRequest } from '../domain/types.ts';

/** Validates the POST /api/audits body (business_name, website, location, lead_id). */
export function validateRequest(body: unknown): { ok: true; value: AuditRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
  const business_name = str('business_name');
  const website = str('website');
  const location = str('location');
  if (!business_name) return { ok: false, error: 'business_name is required' };
  if (!location) return { ok: false, error: 'location is required' };
  if (!website) return { ok: false, error: 'website is required' };
  const value: AuditRequest = { business_name, website, location };
  const lead_id = str('lead_id');
  if (lead_id) value.lead_id = lead_id;
  const industry_hint = str('industry_hint') || str('industry');
  if (industry_hint) value.industry_hint = industry_hint;
  if (b.include_brand_diagnostic === true) value.include_brand_diagnostic = true;
  return { ok: true, value };
}
