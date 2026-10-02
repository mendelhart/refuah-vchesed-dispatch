/**
 * The card a volunteer holds up at a hospital reception desk.
 *
 * Two constraints shaped it. It is read at arm's length by somebody who is not
 * looking for it, so the name and the volunteer number are the largest things
 * on the page and nothing competes with them. And it has to survive being
 * printed on the office laser printer, so the print rules below hide the app
 * shell and leave the card alone on the sheet.
 *
 * The QR code is generated here rather than pulled from an image service: a
 * card shown at a desk with no signal still has to scan, and sending a
 * volunteer's verification link to a third-party chart API would leak it.
 */
import { Link } from 'react-router-dom';
import React, { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Printer, RefreshCw } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatMonthYear, titleCase, formatPhone } from '@/lib/format';
import { ErrorState, ListSkeleton, PageHeader, primaryButtonClass, secondaryButtonClass } from '@/components/states';

interface IdCardData {
  volunteerNumber: string;
  fullName: string;
  role: string;
  photo: string | null;
  groups: string[];
  services: string[];
  capabilities: string[];
  memberSince: string | null;
  organization: { name: string; phone: string | null };
  verificationCode: string;
}

// ---------------------------------------------------------------------------
// QR encoder — byte mode, error correction level M, versions 1 to 10.
//
// Written out in full because a scanned code either decodes or it does not:
// there is no partially-working QR, and a card that fails at the desk is worse
// than one that never claimed to have a code. Error correction M (roughly 15%
// recoverable) is the level that still reads off a creased, pocket-worn card.
// ---------------------------------------------------------------------------

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_PER_VERSION = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

/** Multiplication in GF(256) with the QR primitive polynomial. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    for (let i = 0; i < divisor.length; i += 1) {
      result[i] = (result[i] ?? 0) ^ gfMultiply(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

/** Total data + error correction modules available in a version. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewordCount(version: number): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    (ECC_PER_BLOCK[version] ?? 0) * (BLOCKS_PER_VERSION[version] ?? 0)
  );
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

function formatBits(mask: number): number {
  // Error correction level M is 0b00 in the format field.
  const value = (0b00 << 3) | mask;
  let remainder = value;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((value << 10) | remainder) ^ 0x5412;
}

function maskAt(mask: number, x: number, y: number): boolean {
  if (mask === 0) return (x + y) % 2 === 0;
  if (mask === 1) return y % 2 === 0;
  if (mask === 2) return x % 3 === 0;
  if (mask === 3) return (x + y) % 3 === 0;
  if (mask === 4) return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
  if (mask === 5) return ((x * y) % 2) + ((x * y) % 3) === 0;
  if (mask === 6) return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
  return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
}

function linePenalty(line: boolean[]): number {
  let score = 0;
  let run = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === line[i - 1]) {
      run += 1;
      if (run === 5) score += 3;
      else if (run > 5) score += 1;
    } else {
      run = 1;
    }
  }
  const text = line.map((dark) => (dark ? '1' : '0')).join('');
  for (const pattern of ['10111010000', '00001011101']) {
    let index = text.indexOf(pattern);
    while (index !== -1) {
      score += 40;
      index = text.indexOf(pattern, index + 1);
    }
  }
  return score;
}

function gridPenalty(grid: boolean[][], size: number): number {
  const cell = (x: number, y: number): boolean => grid[y]?.[x] ?? false;
  let score = 0;
  for (let y = 0; y < size; y += 1) score += linePenalty(grid[y] ?? []);
  for (let x = 0; x < size; x += 1) {
    const column: boolean[] = [];
    for (let y = 0; y < size; y += 1) column.push(cell(x, y));
    score += linePenalty(column);
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = cell(x, y);
      if (value === cell(x + 1, y) && value === cell(x, y + 1) && value === cell(x + 1, y + 1)) score += 3;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (cell(x, y)) dark += 1;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

interface QrMatrix {
  size: number;
  modules: boolean[][];
}

/** Returns null when the text is longer than version 10 at level M can carry. */
function encodeQr(text: string): QrMatrix | null {
  const bytes = Array.from(new TextEncoder().encode(text));

  let version = 0;
  for (let candidate = 1; candidate <= MAX_VERSION; candidate += 1) {
    const lengthBits = candidate <= 9 ? 8 : 16;
    if (4 + lengthBits + bytes.length * 8 <= dataCodewordCount(candidate) * 8) {
      version = candidate;
      break;
    }
  }
  if (version === 0) return null;

  const size = version * 4 + 17;
  const bits: number[] = [];
  const pushBits = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  pushBits(0b0100, 4); // byte mode
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) pushBits(byte, 8);

  const capacityBits = dataCodewordCount(version) * 8;
  pushBits(0, Math.min(4, capacityBits - bits.length));
  pushBits(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) pushBits(pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    data.push(byte);
  }

  const blockCount = BLOCKS_PER_VERSION[version] ?? 1;
  const eccLength = ECC_PER_BLOCK[version] ?? 0;
  const totalCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (totalCodewords % blockCount);
  const shortLength = Math.floor(totalCodewords / blockCount);
  const divisor = reedSolomonDivisor(eccLength);

  const blocks: number[][] = [];
  for (let i = 0, cursor = 0; i < blockCount; i += 1) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(cursor, cursor + length);
    cursor += length;
    const ecc = reedSolomonRemainder(block, divisor);
    // Short blocks carry a placeholder so every block is the same length while
    // interleaving; the placeholder column is skipped when it is read back out.
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }

  const codewords: number[] = [];
  const blockLength = blocks[0]?.length ?? 0;
  for (let i = 0; i < blockLength; i += 1) {
    for (let j = 0; j < blocks.length; j += 1) {
      if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(blocks[j]?.[i] ?? 0);
    }
  }

  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunction = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const row = modules[y];
    const flags = reserved[y];
    if (row) row[x] = dark;
    if (flags) flags[x] = true;
  };

  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const last = positions.length - 1;
      const overlapsFinder = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (overlapsFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(
            (positions[i] ?? 0) + dx,
            (positions[j] ?? 0) + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
        }
      }
    }
  }

  const placeFormat = (mask: number, write: (x: number, y: number, dark: boolean) => void): void => {
    const format = formatBits(mask);
    const bit = (i: number): boolean => ((format >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) write(8, i, bit(i));
    write(8, 7, bit(6));
    write(8, 8, bit(7));
    write(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) write(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) write(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) write(8, size - 15 + i, bit(i));
    write(8, size - 8, true); // always dark
  };
  placeFormat(0, setFunction); // reserves the cells; the chosen mask overwrites them

  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const versionValue = (version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((versionValue >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if ((reserved[y]?.[x] ?? true) || bitIndex >= codewords.length * 8) continue;
        const row = modules[y];
        if (row) row[x] = (((codewords[bitIndex >>> 3] ?? 0) >>> (7 - (bitIndex & 7))) & 1) !== 0;
        bitIndex += 1;
      }
    }
  }

  let best: boolean[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => row.slice());
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (reserved[y]?.[x] || !maskAt(mask, x, y)) continue;
        const row = candidate[y];
        if (row) row[x] = !(row[x] ?? false);
      }
    }
    placeFormat(mask, (x, y, dark) => {
      const row = candidate[y];
      if (row) row[x] = dark;
    });
    const score = gridPenalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best ? { size, modules: best } : null;
}

/** One SVG path built from horizontal runs, so a version 10 code is still small. */
export function QrCode({ text, title }: { text: string; title: string }): React.JSX.Element | null {
  const matrix = useMemo(() => encodeQr(text), [text]);
  if (!matrix) return null;

  const quiet = 4;
  const extent = matrix.size + quiet * 2;
  const segments: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    const row = matrix.modules[y] ?? [];
    let x = 0;
    while (x < matrix.size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < matrix.size && row[x + run]) run += 1;
      segments.push(`M${x + quiet} ${y + quiet}h${run}v1h-${run}z`);
      x += run;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={title}
      shapeRendering="crispEdges"
      className="h-full w-full"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={segments.join('')} fill="#0f172a" />
    </svg>
  );
}

const PRINT_STYLES = `
@media print {
  body * { visibility: hidden !important; }
  #volunteer-id-card, #volunteer-id-card * { visibility: visible !important; }
  #volunteer-id-card {
    position: absolute;
    left: 0;
    top: 0;
    width: 88mm;
    box-shadow: none !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @page { margin: 12mm; }
}
`;

export function MyIdCardPage(): React.JSX.Element {
  const idCard = useQuery({
    queryKey: qk.meExtras.idCard(),
    queryFn: () => api.get<{ card: IdCardData }>('/api/me/id-card'),
  });
  const [confirmReissue, setConfirmReissue] = useState(false);
  const reissue = useMutation({
    mutationFn: () => api.post<{ card: IdCardData }>('/api/me/id-card/reissue', {}),
    onSuccess: () => {
      setConfirmReissue(false);
      void idCard.refetch();
      toast.success('New card code issued. The old card no longer checks out. Print the new one.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (idCard.isPending) return <ListSkeleton rows={2} lines={4} />;
  if (idCard.isError) {
    return <ErrorState error={idCard.error} onRetry={() => void idCard.refetch()} what="your ID card" />;
  }

  const card = idCard.data.card;
  const verifyUrl = `${window.location.origin}/verify/${card.verificationCode}`;

  return (
    <div className="space-y-6">
      <style>{PRINT_STYLES}</style>

      <PageHeader
        title="My ID card"
        subtitle="Show this at a reception desk when you are asked who you are with"
        actions={
          <span className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButtonClass} onClick={() => window.print()}>
              <Printer className="h-4 w-4" aria-hidden="true" />
              Print
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setConfirmReissue((v) => !v)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Lost card?
            </button>
          </span>
        }
      />
      {confirmReissue ? (
        <div className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
          <p className="text-slate-700 dark:text-slate-200">
            Lost your card? Get a new QR code. Anyone scanning the old card will see it is not valid. Your volunteer
            number stays the same. Print the new card afterwards.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={primaryButtonClass} disabled={reissue.isPending} onClick={() => reissue.mutate()}>
              {reissue.isPending ? 'Issuing…' : 'Issue a new code'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setConfirmReissue(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {!card.photo ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Add a clear photo of your face so reception desks can match you to your card. You can add or change it in{' '}
          <Link to="/settings" className="font-semibold underline">Settings</Link>.
        </p>
      ) : null}

      {/*
        The card keeps one fixed appearance in both themes on purpose: it is the
        same object on a screen and on paper, and a desk clerk comparing the two
        should not be shown two different-looking cards.
      */}
      <div
        id="volunteer-id-card"
        className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-lg"
      >
        <div className="bg-[#EA0029] px-5 py-4 text-white">
          <p className="text-lg font-bold leading-tight">{card.organization.name}</p>
          <p className="text-xs uppercase tracking-widest text-white">Volunteer identification</p>
        </div>

        <div className="space-y-5 px-5 py-6">
          <div className="flex items-start gap-4">
            {card.photo ? (
              <img
                src={card.photo}
                alt={`Photo of ${card.fullName}`}
                className="h-28 w-24 flex-shrink-0 rounded-lg border border-slate-200 object-cover"
              />
            ) : null}
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-slate-600">Name</p>
              <p className="text-3xl font-bold leading-tight text-slate-900">{card.fullName}</p>
              <p className="mt-1 text-sm text-slate-600">{titleCase(card.role)}</p>
            </div>
          </div>

          <div>
            <p className="text-xs uppercase tracking-wide text-slate-600">Volunteer number</p>
            <p className="font-mono text-4xl font-bold leading-tight tracking-tight text-slate-900">
              {card.volunteerNumber}
            </p>
          </div>

          {card.groups.length > 0 ? (
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-600">Groups</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {card.groups.map((group) => (
                  <span key={group} className="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-medium text-slate-700">
                    {group}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {card.services.length > 0 ? (
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-600">Helps with</p>
              <p className="text-sm text-slate-700">{card.services.join(' · ')}</p>
            </div>
          ) : null}

          <div className="flex items-center gap-4 border-t border-slate-200 pt-5">
            <div className="h-28 w-28 flex-shrink-0">
              <QrCode text={verifyUrl} title={`Verification code for volunteer ${card.volunteerNumber}`} />
            </div>
            <div className="min-w-0 text-sm text-slate-600">
              <p className="font-medium text-slate-900">Checking this card</p>
              <p className="mt-1">Scan the code, or type the address below into a browser.</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-700">{verifyUrl}</p>
            </div>
          </div>

          <div className="flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-4 text-xs text-slate-600">
            <span>
              {card.memberSince ? `Volunteering since ${formatMonthYear(card.memberSince)}` : 'Volunteer'}
            </span>
            {card.organization.phone ? <span>Office {formatPhone(card.organization.phone)}</span> : null}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-sm text-sm text-slate-600 dark:text-slate-400">
        <p>
          A receptionist can scan the code or type that address in to see your name and that your card is current.
          Nothing else about you is shown there.
        </p>
        <p className="mt-2">
          Printing gives you the card on its own, without the rest of this page. If your card is lost, tell the office
          so the number can be retired.
        </p>
      </div>
    </div>
  );
}
