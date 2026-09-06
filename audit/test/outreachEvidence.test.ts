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
