import assert from 'node:assert/strict';
import test from 'node:test';
import { generateOutreach } from '../src/outreach/generate.ts';
import type { Competitor, Prospect } from '../src/domain/types.ts';

const prospect: Prospect = {
  name: 'AI Listings',
  website: 'https://ailistings.co.uk',
  domain: 'ailistings.co.uk',
  location: 'Warrington',
};

function competitor(name: string, layers: Competitor['layers']): Competitor {
  return { name, layers, mentions: 1, score: 1 };
}

test('direct recommendation wording names only RECOMMENDED-layer competitors', () => {
  const message = generateOutreach({
    prospect,
    service: 'AI search visibility',
    status: 'COMPLETE',
    states: { VISIBLE: 'NO', RECOMMENDED: 'NO', CONVERSATIONAL: 'NO' },
    competitors: [
      competitor('Gregg King', ['CONVERSATIONAL']),
      competitor('Morgan Digital', ['CONVERSATIONAL']),
      competitor('Direct First', ['RECOMMENDED']),
      competitor('21 Degrees Digital', ['RECOMMENDED']),
      competitor('HDC Consultancy', ['RECOMMENDED']),
    ],
  });

  assert.match(message ?? '', /Direct First/);
  assert.match(message ?? '', /21 Degrees Digital/);
  assert.match(message ?? '', /HDC Consultancy/);
  assert.doesNotMatch(message ?? '', /Gregg King/);
  assert.doesNotMatch(message ?? '', /Morgan Digital/);
});

test('mixed result branch names competitors from the layer that was missed', () => {
  const message = generateOutreach({
    prospect,
    service: 'AI search visibility',
    status: 'COMPLETE',
    states: { VISIBLE: 'NO', RECOMMENDED: 'YES', CONVERSATIONAL: 'NO' },
    competitors: [
      competitor('Direct First', ['RECOMMENDED']),
      competitor('Gregg King', ['CONVERSATIONAL']),
    ],
  });

  assert.match(message ?? '', /Gregg King/);
  assert.doesNotMatch(message ?? '', /Direct First.*forward instead/);
});

test('mixed result SMS uses verified competitors from other layers with safe cross-search wording', () => {
  const message = generateOutreach({
    prospect,
    service: 'AI SEO, AEO, GEO and AI visibility optimisation services',
    status: 'COMPLETE',
    states: { VISIBLE: 'YES', RECOMMENDED: 'NO', CONVERSATIONAL: 'YES' },
    competitors: [
      competitor('Atomic Digital Marketing', ['CONVERSATIONAL']),
      competitor('Morgan Digital', ['CONVERSATIONAL']),
      competitor('Mosaic', ['CONVERSATIONAL']),
    ],
    firstProspectTurn: { VISIBLE: 0, CONVERSATIONAL: 1 },
  });

  assert.match(
    message ?? '',
    /recommended you after we described the problem and then asked who we should speak to/,
  );
  assert.match(message ?? '', /when we asked directly who it would recommend it didn't mention you/);
  assert.match(
    message ?? '',
    /Across the searches we ran, ChatGPT also surfaced Atomic Digital Marketing, Morgan Digital and Mosaic/,
  );
  assert.doesNotMatch(
    message ?? '',
    /asked directly who it would recommend[^.]*Atomic Digital Marketing[^.]*forward instead/,
  );
});

test('mixed result SMS keeps exact instead wording when competitors are verified in the missed layer', () => {
  const message = generateOutreach({
    prospect,
    service: 'AI search visibility',
    status: 'COMPLETE',
    states: { VISIBLE: 'YES', RECOMMENDED: 'NO', CONVERSATIONAL: 'YES' },
    competitors: [
      competitor('Direct First', ['RECOMMENDED']),
      competitor('Atomic Digital Marketing', ['CONVERSATIONAL']),
    ],
    firstProspectTurn: { VISIBLE: 0, CONVERSATIONAL: 1 },
  });

  assert.match(message ?? '', /put Direct First forward instead/);
  assert.doesNotMatch(message ?? '', /Atomic Digital Marketing.*forward instead/);
});

test('cross-search competitor context is capped at the top three verified names', () => {
  const message = generateOutreach({
    prospect,
    service: 'AI search visibility',
    status: 'COMPLETE',
    states: { VISIBLE: 'YES', RECOMMENDED: 'NO', CONVERSATIONAL: 'YES' },
    competitors: [
      competitor('One Agency', ['CONVERSATIONAL']),
      competitor('Two Agency', ['CONVERSATIONAL']),
      competitor('Three Agency', ['CONVERSATIONAL']),
      competitor('Four Agency', ['VISIBLE']),
    ],
    firstProspectTurn: { VISIBLE: 0, CONVERSATIONAL: 1 },
  });

  assert.match(message ?? '', /One Agency/);
  assert.match(message ?? '', /Two Agency/);
  assert.match(message ?? '', /Three Agency/);
  assert.doesNotMatch(message ?? '', /Four Agency/);
});
