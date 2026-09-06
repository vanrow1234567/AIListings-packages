import type { AuditRecord, OutreachReview } from '../domain/types.ts';

type Now = () => string;

const defaultNow: Now = () => new Date().toISOString();

export function preferredOutreachMessage(
  record: AuditRecord,
): { message: string; source: 'PROSPECT_AUDIT' | 'COMPETITOR_FIRST' } | undefined {
  const prospectMessage = record.outreachMessage?.trim();
  if (record.status === 'COMPLETE' && prospectMessage) {
    return { message: prospectMessage, source: 'PROSPECT_AUDIT' };
  }

  const competitorMessage = record.competitorOutreachMessage?.trim();
  if (competitorMessage) {
    return { message: competitorMessage, source: 'COMPETITOR_FIRST' };
  }

  return undefined;
}

/**
 * Create/reset the current human-review draft from the latest released audit output.
 * A SENT record is an immutable historical fact and is never rewritten.
 */
export function refreshOutreachReview(record: AuditRecord, now: Now = defaultNow): void {
  if (record.outreachReview?.status === 'SENT') return;

  const candidate = preferredOutreachMessage(record);
  if (!candidate) {
    delete record.outreachReview;
    return;
  }

  const next: OutreachReview = {
    status: 'PENDING_REVIEW',
    generatedMessage: candidate.message,
    generatedAt: now(),
    source: candidate.source,
  };

  const phone = record.request.phone?.trim();
  const contactName = record.request.contact_name?.trim();
  if (phone) next.recipientPhone = phone;
  if (contactName) next.contactName = contactName;

  record.outreachReview = next;
}

export function clearPendingOutreachReview(record: AuditRecord): void {
  if (record.outreachReview?.status !== 'SENT') delete record.outreachReview;
}

function requiredReview(record: AuditRecord): OutreachReview {
  if (!record.outreachReview) throw new Error('No outreach message is available for review.');
  return record.outreachReview;
}

function cleanMessage(message: unknown): string {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw new Error('Approved message is required.');
  if (text.length > 2000) throw new Error('Approved message is too long.');
  return text;
}

export function approveOutreachReview(
  record: AuditRecord,
  message: unknown,
  recipientPhone?: unknown,
  now: Now = defaultNow,
): OutreachReview {
  const review = requiredReview(record);
  if (review.status === 'SENT') throw new Error('Sent outreach is immutable.');

  const approvedMessage = cleanMessage(message);
  const suppliedPhone =
    typeof recipientPhone === 'string' ? recipientPhone.trim() : '';

  review.status = 'APPROVED';
  review.approvedMessage = approvedMessage;
  review.approvedAt = now();
  if (suppliedPhone) review.recipientPhone = suppliedPhone;
  delete review.rejectedAt;
  delete review.rejectionReason;
  return review;
}

export function rejectOutreachReview(
  record: AuditRecord,
  reason?: unknown,
  now: Now = defaultNow,
): OutreachReview {
  const review = requiredReview(record);
  if (review.status === 'SENT') throw new Error('Sent outreach is immutable.');

  review.status = 'REJECTED';
  review.rejectedAt = now();
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanReason) review.rejectionReason = cleanReason;
  else delete review.rejectionReason;
  delete review.approvedMessage;
  delete review.approvedAt;
  return review;
}

/**
 * MVP transport boundary: the operator confirms that the exact approved SMS was
 * manually sent. Later GHL/Twilio transport can call the same state transition only
 * after the provider accepts this exact payload.
 */
export function confirmOutreachSent(
  record: AuditRecord,
  now: Now = defaultNow,
): OutreachReview {
  const review = requiredReview(record);
  if (review.status !== 'APPROVED') {
    throw new Error('Outreach must be approved before it can be marked sent.');
  }
  if (!review.approvedMessage) throw new Error('Approved message is missing.');
  if (!review.recipientPhone?.trim()) {
    throw new Error('Recipient phone is required before SMS can be marked sent.');
  }

  review.status = 'SENT';
  review.sentMessage = review.approvedMessage;
  review.sentAt = now();
  review.channel = 'SMS';
  return review;
}
