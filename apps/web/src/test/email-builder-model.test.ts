import { describe, expect, it } from 'vitest';
import { renderEmail } from '@rvc/shared';
import { insertField, moveBlock, newBlock, previewValues, removeBlock, sameDesign, validateDesign } from '../pages/email-builder-model';

describe('email builder model', () => {
  const blocks = [newBlock('heading'), newBlock('text'), newBlock('divider')];

  it('moves and removes blocks, ignoring moves off the ends', () => {
    expect(moveBlock(blocks, 0, 1).map((b) => b.type)).toEqual(['text', 'heading', 'divider']);
    expect(moveBlock(blocks, 0, -1)).toBe(blocks);
    expect(moveBlock(blocks, 2, 1)).toBe(blocks);
    expect(removeBlock(blocks, 1).map((b) => b.type)).toEqual(['heading', 'divider']);
  });

  it('puts a merge field where the cursor was, or at the end', () => {
    expect(insertField('Hello !', 'firstName', 6)).toEqual({ text: 'Hello {{firstName}}!', cursor: 19 });
    expect(insertField('Hi ', 'today', null)).toEqual({ text: 'Hi {{today}}', cursor: 12 });
  });

  it('gives plain messages, attached to the block they belong to', () => {
    const errors = validateDesign({ name: '', subject: 'Hi {{nope}}', blocks: [{ type: 'heading', text: 'Hi' }, { type: 'image', url: 'http://x', alt: '' }] });
    expect(errors.name).toMatch(/name/);
    expect(errors.subject).toMatch(/Unknown merge field: nope/);
    expect(errors['blocks.0']).toBeUndefined();
    expect(errors['blocks.1']).toMatch(/https/);
    expect(validateDesign({ name: 'ok', subject: 'Hello', blocks: [] })).toEqual({});
  });

  it('notices unsaved changes', () => {
    const a = { name: 'a', subject: 's', blocks: [newBlock('divider')] };
    expect(sameDesign(a, { ...a, blocks: [newBlock('divider')] })).toBe(true);
    expect(sameDesign(a, { ...a, subject: 't' })).toBe(false);
  });

  it('previews with the signed-in person’s own first name', () => {
    const r = renderEmail({ subject: 'Hi {{firstName}}', blocks: [{ type: 'text', text: '{{organizationName}}' }] }, previewValues('Sara Klein', 'RVC', new Date('2026-10-01T15:00:00Z')));
    expect(r.subject).toBe('Hi Sara');
    expect(r.html).toContain('RVC');
  });
});
