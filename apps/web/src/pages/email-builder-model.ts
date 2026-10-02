import { emailDesignInputSchema, mergeDate, sampleMergeValues, type EmailBlock, type EmailDesignInput, type MergeField } from '@rvc/shared';

/** Email builder (item 9): the editor's pure logic, kept here so it is tested
 *  without a browser. */

export type BlockType = EmailBlock['type'];

export const BLOCK_LABELS: Record<BlockType, string> = {
  heading: 'Heading',
  text: 'Paragraph',
  button: 'Button',
  image: 'Picture',
  divider: 'Line',
};

export const FIELD_LABELS: Record<MergeField, string> = {
  firstName: 'First name',
  fullName: 'Full name',
  organizationName: 'Organization',
  today: 'Today’s date',
};

export function newBlock(type: BlockType): EmailBlock {
  switch (type) {
    case 'heading': return { type, text: '' };
    case 'text': return { type, text: '' };
    case 'button': return { type, label: '', url: 'https://' };
    case 'image': return { type, url: 'https://', alt: '' };
    case 'divider': return { type };
  }
}

/** Moves block `i` one place up (-1) or down (+1); out of range is a no-op. */
export function moveBlock(blocks: EmailBlock[], i: number, by: -1 | 1): EmailBlock[] {
  const j = i + by;
  if (i < 0 || i >= blocks.length || j < 0 || j >= blocks.length) return blocks;
  const out = [...blocks];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

export function removeBlock(blocks: EmailBlock[], i: number): EmailBlock[] {
  return blocks.filter((_, k) => k !== i);
}

/** Puts `{{field}}` into `text` where the cursor was (or at the end). */
export function insertField(text: string, field: MergeField, at: number | null): { text: string; cursor: number } {
  const token = `{{${field}}}`;
  const pos = at === null || at < 0 || at > text.length ? text.length : at;
  return { text: text.slice(0, pos) + token + text.slice(pos), cursor: pos + token.length };
}

/** Plain messages, keyed by where they belong ('name', 'subject', 'blocks.2'). */
export function validateDesign(d: EmailDesignInput): Record<string, string> {
  const res = emailDesignInputSchema.safeParse(d);
  if (res.success) return {};
  const out: Record<string, string> = {};
  for (const issue of res.error.issues) {
    const key = issue.path[0] === 'blocks' && typeof issue.path[1] === 'number' ? `blocks.${issue.path[1]}` : String(issue.path[0] ?? 'form');
    out[key] ??= issue.message;
  }
  return out;
}

export function sameDesign(a: EmailDesignInput, b: EmailDesignInput): boolean {
  return a.name === b.name && a.subject === b.subject && JSON.stringify(a.blocks) === JSON.stringify(b.blocks);
}

/** What the preview fills in: the signed-in person's own details. */
export function previewValues(fullName: string, organizationName: string, now: Date) {
  return sampleMergeValues({ fullName }, organizationName, mergeDate(now));
}
