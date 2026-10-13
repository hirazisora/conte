export const VERSION = 1;
export const COLORS = ['#92502a', '#256c73', '#7052a0', '#356735', '#aa405c', '#735c14'];
export const newId = () => crypto.randomUUID();
export const clone = value => JSON.parse(JSON.stringify(value));

function fail(path, message) { throw new Error(`${path}: ${message}`); }
function obj(value, path, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'オブジェクトが必要です');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(path, `未対応の項目「${key}」があります`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(path, `「${key}」がありません`);
}
function str(value, path, nonempty = false) {
  if (typeof value !== 'string' || value.length > 100000 || (nonempty && !value.trim())) fail(path, '有効な文字列が必要です');
}
export function validateProject(value) {
  const ids = new Set();
  const id = (value, path) => { str(value, path, true); if (ids.has(value)) fail(path, 'IDが重複しています'); ids.add(value); };
  obj(value, 'project', ['version', 'id', 'title', 'scenes', ...(Object.hasOwn(value, 'readingDirection') ? ['readingDirection'] : [])]);
  if (Object.hasOwn(value, 'readingDirection') && !['ltr', 'rtl'].includes(value.readingDirection)) fail('readingDirection', 'ltrまたはrtlが必要です');
  if (value.version !== VERSION) fail('version', '対応する形式は1です');
  id(value.id, 'id'); str(value.title, 'title');
  if (!Array.isArray(value.scenes) || value.scenes.length > 500) fail('scenes', '場面は0〜500件の配列が必要です');
  value.scenes.forEach((scene, i) => {
    const p = `scenes[${i}]`;
    obj(scene, p, ['id', 'title', 'description', 'image', 'dialogues', 'comments']);
    id(scene.id, `${p}.id`); str(scene.title, `${p}.title`); str(scene.description, `${p}.description`);
    if (scene.image !== null) {
      obj(scene.image, `${p}.image`, ['name', 'dataUrl', ...(Object.hasOwn(scene.image, 'reference') ? ['reference'] : [])]); str(scene.image.name, `${p}.image.name`, true);
      if (Object.hasOwn(scene.image, 'reference') && (typeof scene.image.reference !== 'string' || !/^images\/[A-Za-z0-9_-]{1,120}\.(png|jpg|jpeg|webp|gif)$/.test(scene.image.reference))) fail(`${p}.image.reference`, 'images内の安全な画像参照が必要です');
      if (scene.image.dataUrl !== null) {
        const data = scene.image.dataUrl;
        if (typeof data !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) fail(`${p}.image.dataUrl`, 'PNG/JPEG/WebP/GIFの埋め込み画像、またはnullが必要です');
        const base64 = data.slice(data.indexOf(',') + 1), padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
        if (base64.length % 4 !== 0 || base64.length * 3 / 4 - padding > 15 * 1024 * 1024) fail(`${p}.image.dataUrl`, '有効なBase64が必要です（画像は15MBまで）');
      }
    }
    for (const key of ['dialogues', 'comments']) if (!Array.isArray(scene[key]) || scene[key].length > 1000) fail(`${p}.${key}`, '1000件までの配列が必要です');
    scene.dialogues.forEach((line, j) => { const q = `${p}.dialogues[${j}]`; obj(line, q, ['id', 'speaker', 'text', ...(Object.hasOwn(line, 'stageDirection') ? ['stageDirection'] : [])]); id(line.id, `${q}.id`); str(line.speaker, `${q}.speaker`); str(line.text, `${q}.text`); if (Object.hasOwn(line, 'stageDirection')) str(line.stageDirection, `${q}.stageDirection`); });
    scene.comments.forEach((comment, j) => {
      const q = `${p}.comments[${j}]`; obj(comment, q, ['id', 'text', 'color', 'rect']); id(comment.id, `${q}.id`); str(comment.text, `${q}.text`);
      if (typeof comment.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(comment.color)) fail(`${q}.color`, '#RRGGBBが必要です');
      obj(comment.rect, `${q}.rect`, ['x', 'y', 'width', 'height']);
      const { x, y, width, height } = comment.rect;
      if (![x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) || width <= 0 || height <= 0 || x + width > 1 + 1e-9 || y + height > 1 + 1e-9) fail(`${q}.rect`, '左上原点の0〜1座標で、画像内に収まる矩形が必要です');
    });
  });
  const result = clone(value);
  for (const scene of result.scenes) for (const line of scene.dialogues) if (!Object.hasOwn(line, 'stageDirection')) line.stageDirection = '';
  return result;
}
export function createScene(title = '新しい場面') { return { id: newId(), title, description: '', image: null, dialogues: [], comments: [] }; }
export function createProject() { return { version: VERSION, id: newId(), title: '新しいコンテ', readingDirection: 'ltr', scenes: [createScene()] }; }
export function normalizedRect(start, end) {
  const bound = n => Math.max(0, Math.min(1, n));
  const a = { x: bound(start.x), y: bound(start.y) }, b = { x: bound(end.x), y: bound(end.y) };
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
