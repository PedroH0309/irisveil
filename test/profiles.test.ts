import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readProfileFile } from '../src/profiles.js';
import { parseRunInput } from '../src/pipeline.js';
import { IrisError } from '../src/errors.js';

/** A minimal one-page PDF with one line of text per entry, like LinkedIn's "Save to PDF". */
function makePdf(lines: string[]): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) '`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const isInvalid = (e: unknown) => e instanceof IrisError && e.code === 'INVALID_INPUT';

describe('readProfileFile', () => {
  it('reads the text of a LinkedIn PDF', async () => {
    const pdf = makePdf(['Cristina Cordova', 'Chief Operating Officer at Linear', 'Previously built partnerships at Notion and Stripe']);
    const page = await readProfileFile('linkedin', { name: 'Profile.pdf', bytes: pdf });
    assert.equal(page.network, 'linkedin');
    assert.equal(page.url, 'https://www.linkedin.com/');
    assert.match(page.text, /Chief Operating Officer at Linear/);
    assert.match(page.text, /Notion and Stripe/);
    assert.equal(page.title, 'LinkedIn profile (Profile.pdf)');
  });

  it('reads an X Markdown export and tidies whitespace', async () => {
    const md = '# @cjc\r\n\r\n\r\n\r\n**Bio:**   COO at Linear. Writing about operations and go-to-market.\n';
    const page = await readProfileFile('x', { name: 'cjc.md', bytes: new TextEncoder().encode(md) });
    assert.equal(page.url, 'https://x.com/');
    assert.equal(page.text, '# @cjc\n\n**Bio:** COO at Linear. Writing about operations and go-to-market.');
  });

  it('rejects the wrong kind of file, empty files and unreadable PDFs', async () => {
    const md = new TextEncoder().encode('# Not a PDF at all, just some Markdown text here');
    await assert.rejects(readProfileFile('linkedin', { name: 'x.md', bytes: md }), isInvalid);
    await assert.rejects(readProfileFile('x', { name: 'p.pdf', bytes: makePdf(['hello']) }), isInvalid);
    await assert.rejects(readProfileFile('x', { name: 'e.md', bytes: new Uint8Array() }), isInvalid);
    await assert.rejects(readProfileFile('x', { name: 'short.md', bytes: new TextEncoder().encode('hi') }), isInvalid);
    await assert.rejects(readProfileFile('linkedin', { name: 'bad.pdf', bytes: new TextEncoder().encode('%PDF-1.4 garbage') }), isInvalid);
  });
});

describe('profile files in run input', () => {
  it('decodes base64 uploads and ignores empty ones', () => {
    const data = Buffer.from('# @cjc\nCOO at Linear').toString('base64');
    const input = parseRunInput({ url: 'linear.app', x: { name: 'cjc.md', data }, linkedin: { name: '', data: '' } });
    assert.equal(input.x?.name, 'cjc.md');
    assert.equal(new TextDecoder().decode(input.x?.bytes), '# @cjc\nCOO at Linear');
    assert.equal(input.linkedin, undefined);
  });

  it('rejects files over 2 MB', () => {
    const data = 'A'.repeat(3 * 1024 * 1024);
    assert.throws(() => parseRunInput({ url: 'linear.app', linkedin: { name: 'big.pdf', data } }), isInvalid);
  });
});
