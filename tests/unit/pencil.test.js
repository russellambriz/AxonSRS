// Pencil card composition: the typed answer is graded, drawings are images.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEN_COLORS, PEN_WIDTHS, PAPER, composePencilCard, imageRejectReason, penColor, penWidth } from '../../js/core/pencil.js';

test('pen presets stay ordered and every colour is a dark ink for the paper', () => {
  assert.ok(penWidth('fine').scale < penWidth('medium').scale);
  assert.ok(penWidth('medium').scale < penWidth('broad').scale);
  assert.equal(penWidth('nope').id, 'medium');
  assert.equal(penColor('rose').hex, '#be123c');
  assert.equal(penColor('missing').id, 'graphite');
  assert.equal(PEN_COLORS.length, 5);
  assert.equal(PEN_WIDTHS.length, 3);
  assert.equal(PAPER, '#f6f3ee');
  for (const c of PEN_COLORS) assert.match(c.hex, /^#[0-9a-f]{6}$/);
});

test('a pencil card needs a typed answer, and a drawing is not that answer', () => {
  assert.equal(composePencilCard({}).ok, false);
  assert.match(composePencilCard({ prompt: 'Capital?', frontImage: { id: 'img' } }).error, /answer/);
  assert.match(composePencilCard({ answer: 'Lima' }).error, /prompt/);
  const drawn = composePencilCard({ answer: 'Lima', frontImage: { id: 'sha256-a', alt: 'Handwritten prompt' } });
  assert.equal(drawn.ok, true);
  assert.equal(drawn.front, '![Handwritten prompt](axon-media:sha256-a)');
  assert.equal(drawn.back, 'Lima');
  assert.deepEqual(drawn.mediaIds, ['sha256-a']);
  const both = composePencilCard({
    prompt: 'Capital of Peru',
    answer: 'Lima | Lima, Peru',
    frontImage: { id: 'front' },
    backImage: { id: 'back', alt: 'Handwritten note' },
  });
  assert.equal(both.ok, true);
  assert.match(both.front, /^Capital of Peru\n\n!\[Handwritten prompt\]\(axon-media:front\)$/);
  assert.match(both.back, /^Lima \| Lima, Peru\n\n!\[Handwritten note\]\(axon-media:back\)$/);
  assert.deepEqual(both.mediaIds, ['front', 'back']);
  assert.equal(composePencilCard({ prompt: '  Only text  ', answer: '  Paris  ' }).front, 'Only text');
  assert.equal(composePencilCard({ prompt: '  Only text  ', answer: '  Paris  ' }).back, 'Paris');
});

test('drawings use the same image type and size limits as other card images', () => {
  assert.equal(imageRejectReason({ type: 'image/png', size: 100 }), null);
  assert.match(imageRejectReason({ type: 'image/svg+xml', size: 10 }), /SVG/);
  assert.match(imageRejectReason({ type: '', size: 10 }), /unknown/);
  assert.match(imageRejectReason({ type: 'image/png', size: 5 * 1024 * 1024 + 1 }), /5 MB/);
});
