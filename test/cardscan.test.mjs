// Card scanner unit tests: pure, no sockets or sandbox.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCardScanner, maskCards } from '../src/cardscan.js';

const scan = (s) => createCardScanner().push(Buffer.from(s));

describe('createCardScanner', () => {
  it('finds plain, space-grouped and dash-grouped cards', () => {
    assert.equal(scan('4242424242424242'), true);
    assert.equal(scan('4242 4242 4242 4242'), true);
    assert.equal(scan('4242-4242-4242-4242'), true);
  });

  it('ignores a bad checksum', () => {
    assert.equal(scan('4242424242424241'), false);
  });

  it('ignores 1730000000001 (passes Luhn, first digit 1)', () => {
    assert.equal(scan('1730000000001'), false);
  });

  it('ignores a 20-digit run containing a valid 16-digit card', () => {
    assert.equal(scan('42424242424242421234'), false);
    assert.equal(scan('12344242424242424242'), false);
  });

  it('finds the card split across two chunks at every offset', () => {
    const card = Buffer.from('xx 4242424242424242 yy');
    for (let i = 0; i <= card.length; i++) {
      const s = createCardScanner();
      s.push(card.subarray(0, i));
      assert.equal(s.push(card.subarray(i)), true, `split at ${i}`);
      assert.equal(s.found, true);
    }
  });

  it('finds a card at the end of a 5 MB body with a bounded tail', () => {
    const s = createCardScanner();
    const filler = Buffer.alloc(64 * 1024, 'a');
    let max = 0;
    for (let n = 0; n < 5 * 1024 * 1024; n += filler.length) {
      assert.equal(s.push(filler), false);
      max = Math.max(max, s.tailLength);
    }
    assert.equal(s.push(Buffer.from('4242 4242 4242 4242')), true);
    max = Math.max(max, s.tailLength);
    assert.ok(max <= 40, `tailLength ${max}`);
  });

  it('does not find a card inside a long digit run cut by the tail', () => {
    const s = createCardScanner();
    for (let i = 0; i < 20; i++) s.push(Buffer.from('4242424242'));
    assert.equal(s.found, false);
  });

  it('finds a card followed by a CVV', () => {
    assert.equal(scan('4242 4242 4242 4242 123'), true);
    assert.equal(scan('4242424242424242 123'), true);
    assert.equal(scan('card=4242 4242 4242 4242 12'), true);
  });

  it('stays found', () => {
    const s = createCardScanner();
    s.push(Buffer.from('4242424242424242'));
    assert.equal(s.push(Buffer.from('nothing')), true);
  });
});

describe('maskCards', () => {
  it('masks all but the last 4 digits, keeping separators', () => {
    assert.equal(maskCards('pay 4242 4242 4242 4242 now'), 'pay **** **** **** 4242 now');
    assert.equal(maskCards('4242 4242 4242 4242 123'), '**** **** **** 4242 123');
    assert.equal(maskCards('4242-4242-4242-4242'), '****-****-****-4242');
    assert.equal(maskCards('no card 4242424242424241'), 'no card 4242424242424241');
  });
});
