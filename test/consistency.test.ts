import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaimAgainstQuote } from '../src/consistency.js';

describe('checkClaimAgainstQuote', () => {
  const contradicted: Array<[string, string]> = [
    ["We don't serve enterprise teams.", 'Serves enterprise teams.'],
    ['Available in the US only.', 'Available worldwide.'],
    ['Up to 10 integrations.', 'More than 10 integrations.'],
    ['Plans include at least 5 seats.', 'Plans include up to 3 seats.'],
    ['We never store customer data.', 'Stores customer data.'],
  ];
  for (const [quote, claim] of contradicted) {
    it(`contradicts "${claim}" against "${quote}"`, () => {
      assert.equal(checkClaimAgainstQuote(claim, quote).verdict, 'contradicted');
    });
  }

  const unresolved: Array<[string, string]> = [
    ["We don't serve enterprise teams.", 'Does not serve enterprise teams.'],
    ['We serve small businesses.', 'We serve enterprise teams.'],
    ['Up to 10 integrations.', 'Offers up to 10 integrations.'],
    ['No more than 10 seats per plan.', 'Plans cap at 10 seats.'],
    ['Available in the US only.', 'Available in the US.'],
    ['Trusted by Harbor Foods across 37 sites.', 'Harbor Foods is a customer.'],
  ];
  for (const [quote, claim] of unresolved) {
    it(`leaves "${claim}" against "${quote}" to later checks`, () => {
      assert.equal(checkClaimAgainstQuote(claim, quote).verdict, 'unresolved');
    });
  }
});
