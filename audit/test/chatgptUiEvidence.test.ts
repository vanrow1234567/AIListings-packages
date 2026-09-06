import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCandidates } from '../src/analysis/extract.ts';
import { toMentions } from '../src/competitors/classify.ts';
import type { Prospect } from '../src/domain/types.ts';

const prospect: Prospect = {
  name: 'AI Listings',
  website: 'https://ailistings.co.uk',
  domain: 'ailistings.co.uk',
  location: 'Warrington',
  serviceTerms: ['ai', 'seo', 'geo', 'aeo', 'visibility', 'optimisation'],
};

test('ChatGPT business-marker label surfaces the visible brand and matches the prospect', () => {
  const response = {
    text: [
      'Ai Listings | Ai Seo Agency',
      'Gregg King',
      'If I were choosing in Warrington today, I would start with Gregg King and Ai Listings.',
    ].join('\n'),
    html:
      '<div data-testid="business-marker-label">Ai Listings | Ai Seo Agency</div>' +
      '<button type="button" aria-label="Ai Listings | Ai Seo Agency" data-testid="business-marker-hitbox"></button>' +
      '<a href="https://greggking.co.uk/?utm_source=chatgpt.com">Gregg King</a>',
    links: ['https://greggking.co.uk/?utm_source=chatgpt.com'],
  };

  const candidates = extractCandidates(response);
  const mapCandidate = candidates.find((c) => c.raw === 'Ai Listings');
  assert.ok(mapCandidate, 'visible business marker should yield the brand segment');
  assert.equal(mapCandidate?.source, 'map');

  const mentions = toMentions(candidates, prospect, 'RECOMMENDED', 0);
  const prospectMention = mentions.find((m) => m.kind === 'prospect');
  assert.ok(prospectMention, 'AI Listings business marker should be recognised as the prospect');
  assert.equal(prospectMention?.evidence?.snippet, 'Ai Listings');
  assert.equal(prospectMention?.evidence?.source, 'map');
});

test('webpage citation pill is not extracted as a recommended business', () => {
  const techradar =
    'https://www.techradar.com/pro/website-performance-is-the-new-defining-metric-for-ai-search?utm_source=chatgpt.com';
  const response = {
    text: 'Current guidance emphasises site structure and performance.\nTechRadar\nGregg King',
    html:
      '<span data-testid="webpage-citation-pill">' +
      '<span><a href="' + techradar + '"><span>TechRadar</span></a></span>' +
      '</span>' +
      '<a href="https://greggking.co.uk/?utm_source=chatgpt.com">Gregg King</a>',
    links: [techradar, 'https://greggking.co.uk/?utm_source=chatgpt.com'],
  };

  const candidates = extractCandidates(response);
  assert.equal(candidates.some((c) => c.raw === 'TechRadar'), false);
  assert.equal(candidates.some((c) => c.raw === 'Gregg King'), true);
});

test('ordinary business link outside a citation pill remains extractable', () => {
  const response = {
    text: 'Acme Visibility',
    html: '<a href="https://acme.example/">Acme Visibility</a>',
    links: ['https://acme.example/'],
  };

  const candidates = extractCandidates(response);
  assert.equal(candidates.some((c) => c.raw === 'Acme Visibility' && c.source === 'link'), true);
});
