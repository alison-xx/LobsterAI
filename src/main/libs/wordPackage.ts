import { crc32, inflateRawSync } from 'node:zlib';

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  WORD_MAX_EXPANDED_BYTES, WORD_MAX_FILE_BYTES, WORD_MAX_PART_BYTES, WORD_MAX_PARTS,
  WordFileError,
} from '../../shared/artifactPreview/wordEditing';

export class WordFileException extends Error {
  constructor(readonly code: WordFileError, message: string) {
    super(message);
  }
}

const invalid = (message: string): never => {
  throw new WordFileException(WordFileError.InvalidFile, message);
};
const unsupported = (message: string): never => {
  throw new WordFileException(WordFileError.Unsupported, message);
};
const tooLarge = (): never => {
  throw new WordFileException(WordFileError.TooLarge, 'DOCX exceeds editing limits');
};

const commentPartParser = new XMLParser({
  ignoreAttributes: true, removeNSPrefix: true, ignoreDeclaration: true, ignorePiTags: true,
  parseTagValue: false, trimValues: true, processEntities: false,
});

/** Generators can emit an empty comments.xml even when no annotations exist. */
function isEmptyCommentPart(xml: string): boolean {
  if (XMLValidator.validate(xml) !== true) return false;
  try {
    const parsed: Record<string, unknown> = commentPartParser.parse(xml);
    // Admit only the empty container; unknown children, text and even a blank
    // comment record must keep using preview until review editing is supported.
    return Object.keys(parsed).length === 1 && parsed.comments === '';
  } catch {
    return false;
  }
}

/** Decode XML attribute references once; DTD-defined entities are rejected above. */
function relationshipAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  for (const match of tag.matchAll(/\s([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    const value = match[3].replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_reference, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity];
      const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid('Invalid XML character reference');
      return String.fromCodePoint(code);
    });
    attributes.set(match[1], value);
  }
  return attributes;
}

/**
 * Inspect the ZIP directory BEFORE inflation. Never trust the declared expanded size:
 * zlib gets an output cap too. No entries are extracted to filesystem paths.
 * Deliberately reject ZIP64/encryption and review/active content in this first editor.
 */
export function inspectWordPackage(input: Uint8Array): void {
  if (!(input instanceof Uint8Array)) invalid('Expected DOCX bytes');
  if (input.byteLength > WORD_MAX_FILE_BYTES) tooLarge();
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 22) invalid('Not a ZIP archive');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0) invalid('Missing ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directoryStart === 0xffffffff || directorySize === 0xffffffff
    || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== count) unsupported('ZIP64/multi-disk DOCX');
  if (count > WORD_MAX_PARTS) tooLarge();
  if (directoryStart + directorySize !== end) invalid('Invalid ZIP directory bounds');
  const names = new Set<string>();
  const xml = new Map<string, string>();
  let offset = directoryStart;
  let expandedTotal = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) invalid('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const entryEnd = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (entryEnd > end || local + 30 > directoryStart) invalid('ZIP entry out of bounds');
    if (flags & 1 || ![0, 8].includes(compression)) unsupported('Encrypted or unsupported ZIP entry');
    if (expanded > WORD_MAX_PART_BYTES || expandedTotal + expanded > WORD_MAX_EXPANDED_BYTES) tooLarge();
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')
      || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) invalid('Invalid or duplicate ZIP path');
    names.add(name);
    if (bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 8) !== compression || bytes.readUInt16LE(local + 6) !== flags) invalid('ZIP header mismatch');
    const localNameLength = bytes.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (dataStart + compressed > directoryStart
      || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) invalid('ZIP content bounds mismatch');
    const packed = bytes.subarray(dataStart, dataStart + compressed);
    let content: Buffer;
    try {
      content = compression === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, Math.min(expanded, WORD_MAX_PART_BYTES)) });
    } catch {
      invalid('Invalid or oversized ZIP stream');
    }
    if (content.length !== expanded) invalid('ZIP expanded size mismatch');
    if (crc32(content) !== bytes.readUInt32LE(offset + 16)) invalid('ZIP content checksum mismatch');
    expandedTotal += content.length;
    if (/\.xml$|\.rels$/i.test(name)) {
      const text = decoder.decode(content);
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) unsupported('XML entities are not supported');
      xml.set(name, text);
      // The open core does not expose review management. Preserve such files through preview.
      if (/<(?:[^\s<>/=:]+:)?(?:altChunk|object|documentProtection|ins|del|moveFrom|moveTo|comment|commentRangeStart|commentRangeEnd|commentReference)(?:\s|\/?>)/.test(text)) {
        unsupported('Document contains protected, embedded, or review content');
      }
    }
    if (/(?:^_xmlsignatures\/|vbaProject\.bin$|^word\/embeddings\/)/i.test(name)) {
      unsupported('Signed, macro, embedded, or annotated document');
    }
    if (/^word\/comments[^/]*\.xml$/i.test(name)
      && !(name === 'word/comments.xml' && isEmptyCommentPart(xml.get(name)!))) {
      unsupported('Document contains annotations or unsupported comment metadata');
    }
    offset = entryEnd;
  }
  if (offset !== end) invalid('ZIP directory size mismatch');
  const types = xml.get('[Content_Types].xml');
  const document = xml.get('word/document.xml');
  if (!types?.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
    || !document || !xml.has('_rels/.rels')) invalid('Not a DOCX document package');
  // Block external resources except user-activated hyperlinks; the editor must work offline.
  for (const [name, text] of xml) {
    if (!name.endsWith('.rels')) continue;
    const relations = text.match(/<(?:[^\s<>/=:]+:)?Relationship\b(?:[^"'>]|"[^"]*"|'[^']*')*>/g) ?? [];
    if (relations.some(relation => {
      const attributes = relationshipAttributes(relation);
      return attributes.get('TargetMode')?.toLowerCase() === 'external'
        && !attributes.get('Type')?.endsWith('/hyperlink');
    })) unsupported('Externally linked resource');
  }
}
