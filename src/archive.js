import { clone, validateProject } from './model.js';

export const FORMAT_ID = 'conte.storyboard';
export const FORMAT_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_METADATA_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_ENTRIES = 501;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const extensions = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };
const imagePath = /^images\/[A-Za-z0-9_-]{1,120}\.(png|jpg|jpeg|webp|gif)$/;
const fail = message => { throw new Error(`Conte形式：${message}`); };
export function safeImagePath(path) { return typeof path === 'string' && imagePath.test(path); }

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function bounds(bytes, offset, size) { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) fail('ヘッダーまたはデータが途中で切れています'); }

// ZIP v1 profile: single disk, STORED entries, no extras/descriptors/encryption/ZIP64.
// Reading stays in memory; no archive path is ever written to the filesystem.
export function encodeZip(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ENTRIES) fail('エントリー数は1〜501件です');
  const names = entries.map(entry => encoder.encode(entry.name));
  const localSize = entries.reduce((sum, entry, i) => sum + 30 + names[i].length + entry.bytes.length, 0);
  const directorySize = names.reduce((sum, name) => sum + 46 + name.length, 0);
  const totalSize = localSize + directorySize + 22;
  if (totalSize > MAX_ARCHIVE_BYTES) fail('ファイル全体は50MBまでです');
  const output = new Uint8Array(totalSize), header = view(output);
  let local = 0, central = localSize;
  entries.forEach((entry, i) => {
    const name = names[i], length = entry.bytes.length, crc = crc32(entry.bytes);
    header.setUint32(local, 0x04034b50, true); header.setUint16(local + 4, 10, true); header.setUint16(local + 6, 0x800, true);
    header.setUint16(local + 12, 33, true); header.setUint32(local + 14, crc, true);
    header.setUint32(local + 18, length, true); header.setUint32(local + 22, length, true); header.setUint16(local + 26, name.length, true);
    output.set(name, local + 30); output.set(entry.bytes, local + 30 + name.length);
    header.setUint32(central, 0x02014b50, true); header.setUint16(central + 4, 20, true); header.setUint16(central + 6, 10, true); header.setUint16(central + 8, 0x800, true);
    header.setUint16(central + 14, 33, true); header.setUint32(central + 16, crc, true);
    header.setUint32(central + 20, length, true); header.setUint32(central + 24, length, true); header.setUint16(central + 28, name.length, true); header.setUint32(central + 42, local, true);
    output.set(name, central + 46); local += 30 + name.length + length; central += 46 + name.length;
  });
  header.setUint32(central, 0x06054b50, true); header.setUint16(central + 8, entries.length, true); header.setUint16(central + 10, entries.length, true);
  header.setUint32(central + 12, directorySize, true); header.setUint32(central + 16, localSize, true);
  return output;
}
export function decodeZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_ARCHIVE_BYTES) fail('ファイル全体は50MBまでです');
  if (bytes.length < 22) fail('ZIPヘッダーがありません');
  const header = view(bytes), end = bytes.length - 22;
  if (header.getUint32(end, true) !== 0x06054b50 || header.getUint16(end + 20, true) !== 0) fail('ZIP終端が不正です（コメント付きZIPは未対応）');
  const count = header.getUint16(end + 10, true), directorySize = header.getUint32(end + 12, true), directoryOffset = header.getUint32(end + 16, true);
  if (header.getUint16(end + 4, true) || header.getUint16(end + 6, true) || header.getUint16(end + 8, true) !== count || count < 1 || count > MAX_ENTRIES) fail('分割ZIP・ZIP64・過大なエントリー数は未対応です');
  bounds(bytes, directoryOffset, directorySize); if (directoryOffset + directorySize !== end) fail('中央ディレクトリの範囲が不正です');
  const records = [], names = new Set(); let position = directoryOffset, expanded = 0;
  for (let i = 0; i < count; i++) {
    bounds(bytes, position, 46); if (header.getUint32(position, true) !== 0x02014b50) fail('中央ディレクトリが壊れています');
    const flags = header.getUint16(position + 8, true), method = header.getUint16(position + 10, true);
    const packed = header.getUint32(position + 20, true), size = header.getUint32(position + 24, true), nameLength = header.getUint16(position + 28, true);
    const extraLength = header.getUint16(position + 30, true), commentLength = header.getUint16(position + 32, true), external = header.getUint32(position + 38, true);
    if (header.getUint16(position + 6, true) > 20 || header.getUint16(position + 34, true) || method !== 0 || (flags !== 0 && flags !== 0x800) || extraLength || commentLength) fail('非圧縮ZIP（STORED）のみ対応です。暗号化・圧縮・拡張ヘッダーは使えません');
    if ((external & 0x10) || ![0, 0x8000].includes((external >>> 16) & 0xf000)) fail('フォルダー・リンク・特殊ファイルは使えません');
    bounds(bytes, position + 46, nameLength);
    const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
    if (name !== 'conte.json' && !safeImagePath(name)) fail('許可されていないエントリーパスです');
    if (names.has(name)) fail('同じエントリー名が重複しています'); names.add(name);
    const limit = name === 'conte.json' ? MAX_METADATA_BYTES : MAX_IMAGE_BYTES;
    if (packed !== size || size > limit) fail('エントリーのサイズ上限または宣言サイズが不正です');
    expanded += size; if (expanded > MAX_ARCHIVE_BYTES) fail('展開後の合計は50MBまでです');
    records.push({ name, size, flags, crc: header.getUint32(position + 16, true), offset: header.getUint32(position + 42, true) });
    position += 46 + nameLength;
  }
  if (position !== end || !names.has('conte.json')) fail('conte.jsonまたは中央ディレクトリの件数が不正です');
  const files = new Map(); let expectedOffset = 0;
  for (const record of [...records].sort((a, b) => a.offset - b.offset)) {
    const offset = record.offset;
    if (offset !== expectedOffset) fail('エントリーの重なり・隠れたデータ・不正な位置があります');
    bounds(bytes, offset, 30); if (header.getUint32(offset, true) !== 0x04034b50) fail('ローカルヘッダーが壊れています');
    const nameLength = header.getUint16(offset + 26, true), extraLength = header.getUint16(offset + 28, true);
    if (header.getUint16(offset + 4, true) > 20 || header.getUint16(offset + 6, true) !== record.flags || header.getUint16(offset + 8, true) !== 0 || extraLength || header.getUint32(offset + 14, true) !== record.crc || header.getUint32(offset + 18, true) !== record.size || header.getUint32(offset + 22, true) !== record.size) fail('ローカルと中央のヘッダーが一致しません');
    bounds(bytes, offset + 30, nameLength + record.size);
    if (decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)) !== record.name) fail('エントリー名が一致しません');
    const payload = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + record.size);
    if (crc32(payload) !== record.crc) fail('CRC32が一致しません。ファイルが破損しています');
    files.set(record.name, payload); expectedOffset = offset + 30 + nameLength + record.size;
  }
  if (expectedOffset !== directoryOffset) fail('ローカルデータの範囲が不正です');
  return files;
}
function dataParts(dataUrl) {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/.exec(dataUrl);
  if (!match) fail('対応する画像のData URLが必要です');
  return { mime: match[1], base64: match[2], size: match[2].length * 3 / 4 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0) };
}
function imageMime(bytes) {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 6 && ['GIF87a','GIF89a'].includes(String.fromCharCode(...bytes.subarray(0,6)))) return 'gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0,4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8,12)) === 'WEBP') return 'webp';
  fail('画像バイナリの形式を確認できません');
}
function base64Bytes(base64) { const binary = atob(base64); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
function bytesDataUrl(bytes, mime) { let binary = ''; for (let i=0; i<bytes.length; i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768)); return `data:image/${mime};base64,${btoa(binary)}`; }
export function createMetadata(project) {
  const source = validateProject(project);
  return { format: FORMAT_ID, version: FORMAT_VERSION, id: source.id, title: source.title, ...(Object.hasOwn(source, 'readingDirection') ? { readingDirection: source.readingDirection } : {}), scenes: source.scenes.map((scene, i) => ({ ...scene, image: scene.image === null ? null : { name: scene.image.name, file: scene.image.dataUrl ? `images/${String(i + 1).padStart(4, '0')}.${extensions[dataParts(scene.image.dataUrl).mime]}` : null, ...(scene.image.reference ? { reference: scene.image.reference } : {}) } })) };
}
export function measureConte(project) {
  const metadata = createMetadata(project), json = encoder.encode(JSON.stringify(metadata, null, 2));
  if (json.length > MAX_METADATA_BYTES) fail('メタデータJSONは5MBまでです');
  let size = json.length + 30 + 46 + 2 * 'conte.json'.length + 22;
  project.scenes.forEach((scene, i) => { if (scene.image?.dataUrl) size += dataParts(scene.image.dataUrl).size + 30 + 46 + 2 * metadata.scenes[i].image.file.length; });
  if (size > MAX_ARCHIVE_BYTES) fail('ファイル全体は50MBまでです');
  return size;
}
export function makeConte(project) {
  measureConte(project);
  const metadata = createMetadata(project), entries = [{ name: 'conte.json', bytes: encoder.encode(JSON.stringify(metadata, null, 2)) }];
  project.scenes.forEach((scene, i) => { if (!scene.image?.dataUrl) return; const parts = dataParts(scene.image.dataUrl), bytes = base64Bytes(parts.base64); if (imageMime(bytes) !== parts.mime) fail('画像の宣言形式とバイナリが一致しません'); entries.push({ name: metadata.scenes[i].image.file, bytes }); });
  return encodeZip(entries);
}
export function parseMetadata(value, files = null) {
  if (!value || value.format !== FORMAT_ID || value.version !== FORMAT_VERSION) fail('形式IDまたはバージョンが未対応です');
  const required = ['format','version','id','title','scenes'], allowed = [...required,'readingDirection'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value,key))) fail('メタデータの項目が不正です');
  if (encoder.encode(JSON.stringify(value)).length > MAX_METADATA_BYTES) fail('メタデータJSONは5MBまでです');
  if (!Array.isArray(value.scenes) || value.scenes.length > 500) fail('場面配列が不正です');
  const output = clone(value); delete output.format;
  const used = new Set(['conte.json']); let referencedBytes = 0;
  for (const scene of output.scenes) {
    if (!scene || typeof scene !== 'object') fail('場面が不正です');
    const image = scene.image; if (image === null) continue;
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).some(key => !['name','file','reference'].includes(key)) || !Object.hasOwn(image,'name') || !Object.hasOwn(image,'file') || (image.file !== null && !safeImagePath(image.file)) || (image.reference !== undefined && !safeImagePath(image.reference))) fail('画像参照はimages内の安全なパスにしてください');
    if (image.file && files) {
      const bytes = files.get(image.file); if (!bytes) fail(`画像エントリーがありません：${image.file}`);
      referencedBytes += bytes.length; if (referencedBytes > MAX_ARCHIVE_BYTES) fail('参照画像の合計は50MBまでです（同じ画像の繰り返しも合算）');
      const mime = imageMime(bytes), extension = image.file.split('.').pop();
      if ((mime === 'jpeg' && !['jpg','jpeg'].includes(extension)) || (mime !== 'jpeg' && mime !== extension)) fail('画像の拡張子とバイナリ形式が一致しません');
      used.add(image.file); scene.image = { name: image.name, dataUrl: bytesDataUrl(bytes, mime), ...(image.reference ? { reference: image.reference } : {}) };
    } else scene.image = { name: image.name, dataUrl: null, ...((image.file || image.reference) ? { reference: image.file || image.reference } : {}) };
  }
  if (files && [...files.keys()].some(name => !used.has(name))) fail('メタデータから参照されない画像が含まれています');
  return validateProject(output);
}
export function readConte(input) {
  const files = decodeZip(input); let metadata;
  try { metadata = JSON.parse(decoder.decode(files.get('conte.json'))); } catch { fail('conte.jsonのUTF-8またはJSON構文が不正です'); }
  return parseMetadata(metadata, files);
}
