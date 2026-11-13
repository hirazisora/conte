import { COLORS, clone, createProject, createScene, newId, normalizedRect, validateProject } from './model.js';
import { loadDraft, saveDraft, loadNewProjectBackup, beginNewProject, restoreNewProjectBackup } from './storage.js';
import { MAX_ARCHIVE_BYTES, makeConte, measureConte, readConte } from './archive.js';

const $ = id => document.getElementById(id);
let project = createProject(), activeId = project.scenes[0].id, selectedComment = null;
let undoState = null, saveTimer, revision = 0, savedRevision = -1, saveQueue = Promise.resolve(), loading = true;
let imageReady = false, drawing = null;
const scene = () => project.scenes.find(s => s.id === activeId);
function node(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
function button(text, action, className = '') { const e = node('button', className, text); e.type = 'button'; e.addEventListener('click', action); return e; }
function busy(value) { for (const element of document.querySelectorAll('.workspace,.topbar')) element.inert=value; }
let errorReturnFocus;
function showError(text, focusId) { const dialog = $('error-dialog'); $('error-message').textContent = text; if (!dialog.open) { errorReturnFocus = focusId ? $(focusId) : document.activeElement; if (!errorReturnFocus || errorReturnFocus === document.body || errorReturnFocus.hidden) errorReturnFocus = $('open-conte'); dialog.showModal(); } $('close-error').focus(); }
$('error-dialog').addEventListener('close', () => { const target = errorReturnFocus; errorReturnFocus = null; requestAnimationFrame(() => { if (target?.isConnected && !target.disabled && target.getClientRects().length) target.focus(); else $('open-conte').focus(); }); });
function snapshot(restore) { undoState = restore ? { restore } : { project: clone(project), activeId }; }
function changed() {
  revision++; clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
}
function persist() {
  const data = clone(project), ticket = revision;
  saveQueue = saveQueue.catch(() => {}).then(() => saveDraft(data)).then(() => {
    savedRevision = Math.max(savedRevision, ticket);
  }).catch(() => showError('ブラウザの自動保存ができませんでした。「.conteを保存」でファイルを保管してください。'));
  return saveQueue;
}
async function confirm(title, description, label = '削除する') {
  $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-ok').textContent = label;
  const dialog = $('confirm-dialog'); dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
function renderTabs() {
  const list = $('scene-list'), scroll = list.scrollLeft; list.replaceChildren();
  list.dir = 'ltr';
  const insertion = index => { const label = index === 0 ? '最初に場面を追加' : index === project.scenes.length ? '最後に場面を追加' : `場面${index}と場面${index + 1}の間に追加`; const add = button('＋', () => addSceneAt(index), 'insert-scene'); add.dataset.insertIndex = index; add.setAttribute('aria-label',label); add.title = label; add.disabled = project.scenes.length >= 500; list.append(add); };
  project.scenes.forEach((s, i) => {
    insertion(i);
    const tab = button('', () => { activeId = s.id; selectedComment = null; render(); }, `scene-tab${s.id === activeId ? ' active' : ''}`);
    const item = node('div', `scene-item${s.id === activeId ? ' active' : ''}`); item.dataset.sceneId = s.id;
    const thumb = node('span', 'scene-thumbnail'); thumb.setAttribute('aria-hidden', 'true');
    if (s.image?.dataUrl) thumb.style.backgroundImage = `url("${s.image.dataUrl}")`;
    else thumb.append(node('span', 'thumbnail-description', s.description || (s.image ? '画像を選んで対応づけ' : '構成説明から始める')));
    tab.dataset.sceneId = s.id;
    tab.append(thumb); tab.setAttribute('aria-label', `場面${i + 1}：${s.title || '無題の場面'}`);
    if (s.id === activeId) tab.setAttribute('aria-current', 'true'); item.append(tab);
    const title = node('input', 'scene-title-input'); title.value = s.title; title.placeholder = '無題の場面'; title.dataset.sceneId = s.id; title.setAttribute('aria-label', `場面${i + 1}の名前`);
    title.addEventListener('input', () => { s.title = title.value; changed(); });
    title.addEventListener('focus', () => { if (activeId !== s.id) { activeId = s.id; selectedComment = null; render(); focusSceneTitle(s.id, false); } });
    item.append(title);
    const controls = node('div', 'scene-controls');
    for (const [offset, text, name] of [[-1, '←', '前へ'], [1, '→', '後へ']]) {
      const move = button(text, () => moveScene(s.id, offset)); move.dataset.sceneAction = offset < 0 ? 'previous' : 'next';
      move.setAttribute('aria-label', `場面${i + 1}を${name}`); move.title = `${s.title || '無題の場面'}を${name}`;
      move.disabled = offset < 0 ? i === 0 : i === project.scenes.length - 1; controls.append(move);
    }
    const remove = button('削除', () => deleteScene(s.id), 'danger-text'); remove.dataset.sceneAction = 'delete'; remove.setAttribute('aria-label', `場面${i + 1}を削除`); remove.title = `${s.title || '無題の場面'}を削除`;
    controls.append(remove); item.append(controls); list.append(item);
  });
  insertion(project.scenes.length);
  list.scrollLeft = scroll;
}
function focusSceneTitle(id, select = true) { const input = $('scene-list').querySelector(`.scene-title-input[data-scene-id="${id}"]`); if (!input) return; input.focus({ preventScroll: true }); if (select) input.select(); }
function revealScene() {
  const list = $('scene-list'), tab = list.querySelector('[aria-current="true"]');
  if (!tab) return;
  const a = list.getBoundingClientRect(), b = tab.getBoundingClientRect();
  if (b.left < a.left) list.scrollLeft += b.left - a.left - 4;
  else if (b.right > a.right) list.scrollLeft += b.right - a.right + 4;
}
function render() {
  const s = scene(); $('project-title').value = project.title;
  $('empty-project').hidden = !!s; document.querySelector('.review-panels').hidden = !s;
  if (!s) { renderTabs(); imageReady = false; drawing = null; $('scene-image').removeAttribute('src'); $('rect-layer').replaceChildren(); $('comments').replaceChildren(); $('dialogues').replaceChildren(); return; }
  $('description').value = s.description;
  renderTabs(); renderImage(); renderLines(); renderComments(); revealScene();
}
function renderImage() {
  const s = scene(), image = $('scene-image'); imageReady = false; drawing = null;
  $('image-stage').hidden = true; $('empty-image').hidden = false;
  $('remove-image').hidden = !s.image; $('image-name').textContent = s.image?.name || '';
  $('image-message').textContent = s.image ? `未対応の画像参照：${s.image.reference || s.image.name}` : '画像はまだありません';
  $('empty-image').querySelector('small').textContent = s.image ? 'この場面の画像を確認して「画像を選ぶ」。自動照合はしません。' : '構成説明から始められます';
  const currentId = activeId, currentImage = s.image;
  image.onload = () => {
    if (activeId !== currentId || scene().image !== currentImage) return;
    imageReady = true; $('image-stage').hidden = false; $('empty-image').hidden = true; fitStage(); renderRects();
  };
  image.onerror = () => { if (activeId === currentId) { $('image-message').textContent = '画像を表示できません。正しい画像を選び直してください。'; $('empty-image').hidden = false; $('image-stage').hidden = true; } };
  if (s.image?.dataUrl) { image.src = s.image.dataUrl; if (image.complete && image.naturalWidth) image.onload(); } else image.removeAttribute('src');
  renderRects();
}
// The stylesheet scales the stage to fit the drop zone in both directions (see --image-ratio in style.css).
function fitStage() {
  const image = $('scene-image');
  if (image.naturalWidth && image.naturalHeight) $('image-stage').style.setProperty('--image-ratio', image.naturalWidth / image.naturalHeight);
}
function renderLines(focusId) {
  const s = scene(), list = $('dialogues'); list.replaceChildren();
  if (!s.dialogues.length) list.append(node('p', 'empty-note', 'セリフを追加して、話者と本文を入力してください。'));
  const insertion = index => { const label = index === 0 ? '最初にセリフを追加' : index === s.dialogues.length ? '最後にセリフを追加' : `セリフ${index}とセリフ${index + 1}の間に追加`; const add = button('＋', () => addLineAt(index), 'insert-line'); add.dataset.insertIndex = index; add.setAttribute('aria-label',label); add.title = label; add.disabled = s.dialogues.length >= 1000; list.append(add); };
  s.dialogues.forEach((line, index) => {
    insertion(index);
    const card = node('div', 'line-card'), head = node('div', 'line-head'), label = node('label', 'speaker-label', '話者');
    const input = node('input'); input.value = line.speaker; input.placeholder = 'ナレーション'; input.setAttribute('aria-label', `セリフ${index + 1}の話者`);
    input.addEventListener('input', () => { line.speaker = input.value; changed(); }); label.append(input); head.append(label);
    const tools = node('div', 'line-tools');
    for (const [offset, text, name] of [[-1, '↑', '前へ'], [1, '↓', '後へ']]) {
      const move = button(text, () => { const position = s.dialogues.indexOf(line); s.dialogues.splice(position, 1); s.dialogues.splice(position + offset, 0, line); renderLines(line.id); changed(); });
      move.setAttribute('aria-label', `セリフ${index + 1}を${name}`); move.disabled = offset < 0 ? index === 0 : index === s.dialogues.length - 1; tools.append(move);
    }
    const del = button('削除', async () => { if (await confirm('この脚本ブロックを削除しますか？', 'セリフとト書きをまとめて削除します。Ctrl+Z（⌘Z）で戻せます。')) { const position = s.dialogues.indexOf(line); snapshot(() => { s.dialogues.splice(position, 0, line); activeId = s.id; }); s.dialogues.splice(position, 1); renderLines(); changed(); } });
    del.setAttribute('aria-label', `セリフ${index + 1}を削除`); tools.append(del); head.append(tools); card.append(head);
    const text = node('textarea'); text.value = line.text; text.rows = 4; text.placeholder = 'ここにセリフを入力'; text.dataset.lineId = line.id; text.setAttribute('aria-label', `セリフ${index + 1}の本文`);
    text.addEventListener('input', () => { line.text = text.value; changed(); });
    const speechLabel = node('label', 'script-field', 'セリフ'); speechLabel.append(text);
    const direction = node('textarea'); direction.value = line.stageDirection; direction.rows = 3; direction.placeholder = '例：カップを手に取り、窓の外に目を向ける'; direction.dataset.stageDirectionId = line.id; direction.setAttribute('aria-label', `セリフ${index + 1}のト書き`);
    direction.addEventListener('input', () => { line.stageDirection = direction.value; changed(); });
    const directionLabel = node('label', 'script-field', 'ト書き'); directionLabel.append(direction); card.append(speechLabel, directionLabel); list.append(card);
    if (focusId === line.id) queueMicrotask(() => text.focus());
  });
  insertion(s.dialogues.length);
}
function selectComment(id) { selectedComment = id; renderRects(); for (const card of $('comments').children) card.classList.toggle('selected', card.dataset.commentId === id); }
function renderComments(focusId) {
  const list = $('comments'); list.replaceChildren();
  if (!scene().comments.length) list.append(node('p', 'empty-note comment-empty', 'コメントは有りません。\n気になる場所を囲んで、修正の指示を残せます。'));
  scene().comments.forEach((comment, index) => {
    const card = node('div', `comment-card${selectedComment === comment.id ? ' selected' : ''}`); card.style.setProperty('--color', comment.color); card.dataset.commentId = comment.id;
    const head = node('div', 'comment-head'); head.append(button(`範囲 ${index + 1}`, () => selectComment(comment.id), 'comment-select'));
    head.append(button('削除', async () => { if (await confirm('このコメントを削除しますか？', '画像上の枠も削除します。削除したコメントは戻せません。')) { const s = scene(), position = s.comments.indexOf(comment); s.comments.splice(position, 1); selectedComment = null; renderComments(); renderRects(); changed(); } }, 'delete-small'));
    const text = node('textarea'); text.value = comment.text; text.rows = 2; text.placeholder = '例：見出しをもう少し大きく'; text.setAttribute('aria-label', `範囲${index + 1}のコメント`);
    text.addEventListener('focus', () => selectComment(comment.id)); text.addEventListener('input', () => { comment.text = text.value; changed(); }); card.append(head, text); list.append(card);
    if (focusId === comment.id) queueMicrotask(() => { text.focus(); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  });
  $('comment-hint').textContent = '画像上で範囲指定→コメントを書く';
}
function rectElement(rect, color, className = '') {
  const e = node('div', `rect ${className}`); e.style.setProperty('--color', color);
  for (const [key, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })) e.style[key] = `${value * 100}%`;
  return e;
}
function renderRects() {
  const layer = $('rect-layer'); layer.replaceChildren(); if (!imageReady) return;
  scene().comments.forEach((comment, i) => { const rect = rectElement(comment.rect, comment.color, selectedComment === comment.id ? 'selected' : ''); const mark = button(String(i + 1), () => { selectComment(comment.id); const card = [...$('comments').children].find(c => c.dataset.commentId === comment.id); card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); card?.querySelector('textarea').focus(); }); mark.setAttribute('aria-label', `範囲${i + 1}のコメントへ`); rect.append(mark); layer.append(rect); });
  if (drawing) layer.append(rectElement(normalizedRect(drawing.start, drawing.end), COLORS[scene().comments.length % COLORS.length]));
}
function addComment(rect) {
  if (scene().comments.length >= 1000) { showError('範囲コメントは1場面1000件までです。','drop-zone'); return; }
  const comment = { id: newId(), text: '', color: COLORS[scene().comments.length % COLORS.length], rect };
  scene().comments.push(comment); selectedComment = comment.id; renderComments(comment.id); renderRects(); changed();
}
function point(event) { const b = $('image-stage').getBoundingClientRect(); return { x: (event.clientX - b.left) / b.width, y: (event.clientY - b.top) / b.height }; }
$('image-stage').addEventListener('pointerdown', e => { if (!imageReady || e.button !== 0 || e.target.closest('button')) return; drawing = { start: point(e), end: point(e), pointerId: e.pointerId }; $('image-stage').setPointerCapture(e.pointerId); e.preventDefault(); renderRects(); });
$('image-stage').addEventListener('pointermove', e => { if (!drawing || e.pointerId !== drawing.pointerId) return; drawing.end = point(e); renderRects(); });
$('image-stage').addEventListener('pointerup', e => { if (!drawing || e.pointerId !== drawing.pointerId) return; const rect = normalizedRect(drawing.start, point(e)); drawing = null; $('image-stage').releasePointerCapture(e.pointerId); if (rect.width > 0.005 && rect.height > 0.005) addComment(rect); else renderRects(); });
$('image-stage').addEventListener('pointercancel', () => { drawing = null; renderRects(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawing) { drawing = null; renderRects(); } });

function readFile(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('ファイルを読めませんでした')); reader.readAsDataURL(file); }); }
function decodeImage(dataUrl) { return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(); img.onerror = () => reject(new Error('埋め込み画像が壊れているか、対応していません')); img.src = dataUrl; }); }
async function attachImage(file, targetId) {
  const target = project.scenes.find(s => s.id === targetId); if (!target) return;
  const originalImage = target.image;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('PNG・JPEG・WebP・GIFの画像を選んでください。SVGや外部URLは使えません。');
    if (file.size > 15 * 1024 * 1024) throw new Error('画像は1枚15MBまでです');
    const dataUrl = await readFile(file); await decodeImage(dataUrl);
    if (!project.scenes.includes(target) || target.image !== originalImage) throw new Error('読み込み中に場面の画像が変更されました。対象の場面で選び直してください。');
    if (target.image?.dataUrl || target.comments.length) {
      if (!await confirm('この場面の画像を入れ替えますか？', '既存の範囲コメントは保持します。位置が新しい画像に合うか確認してください。Ctrl+Z（⌘Z）で戻せます。', '入れ替える')) return;
    }
    const candidate = clone(project); candidate.scenes.find(s => s.id === targetId).image = { name: file.name || '貼り付け画像.png', dataUrl };
    measureConte(candidate);
    snapshot(() => { target.image = originalImage; activeId = targetId; }); target.image = { name: file.name || '貼り付け画像.png', dataUrl }; renderTabs(); if (activeId === targetId) { renderImage(); renderComments(); } changed();
  } catch (error) { showError(error.message, 'attach-image'); }
}
let imageTargetId;
$('attach-image').onclick = () => { imageTargetId = activeId; $('image-file').click(); };
$('image-file').onchange = async e => { if (e.target.files[0]) await attachImage(e.target.files[0], imageTargetId); e.target.value = ''; };
for (const name of ['dragenter', 'dragover']) $('drop-zone').addEventListener(name, e => { e.preventDefault(); $('drop-zone').classList.add('dragover'); });
$('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragover'));
$('drop-zone').addEventListener('drop', e => { e.preventDefault(); $('drop-zone').classList.remove('dragover'); const files = [...e.dataTransfer.files]; if (files.length !== 1) { showError('1つの場面に1枚ずつ画像をドロップしてください。自動で割り当てません。', 'attach-image'); return; } void attachImage(files[0], activeId); });
document.addEventListener('paste', e => { if (e.target.closest('input, textarea, dialog')) return; const files = [...(e.clipboardData?.files || [])]; if (!files.length) return; e.preventDefault(); if (files.length !== 1) { showError('画像は1枚ずつ貼り付けてください。', 'attach-image'); return; } void attachImage(files[0], activeId); });
$('remove-image').onclick = async () => { if (await confirm('この場面の画像を外しますか？', '構成説明と範囲コメントは保持します。Ctrl+Z（⌘Z）で画像を戻せます。', '画像を外す')) { const s = scene(), originalImage = s.image; snapshot(() => { s.image = originalImage; activeId = s.id; }); s.image = null; renderTabs(); renderImage(); renderComments(); changed(); } };
$('project-title').oninput = e => { project.title = e.target.value; changed(); };
$('description').oninput = e => { scene().description = e.target.value; renderTabs(); changed(); };
$('scene-list').addEventListener('wheel', e => { const list = e.currentTarget; if (list.scrollWidth <= list.clientWidth || e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; const before = list.scrollLeft; list.scrollLeft += e.deltaY * (list.dir === 'rtl' ? -1 : 1); if (list.scrollLeft !== before) e.preventDefault(); }, { passive: false });
$('scene-list').addEventListener('keydown', e => { if (!['ArrowLeft','ArrowRight'].includes(e.key)) return; const current = e.target.closest('.scene-tab'); if (!current) return; const offset = e.key === 'ArrowRight' ? 1 : -1, index = project.scenes.findIndex(s => s.id === current.dataset.sceneId), next = project.scenes[index + offset]; if (!next) return; e.preventDefault(); activeId = next.id; selectedComment = null; render(); $('scene-list').querySelector('[aria-current="true"]').focus({ preventScroll: true }); });
function addLineAt(index) { const s = scene(); if (!s) return; if (s.dialogues.length >= 1000) { showError('セリフは1場面1000件までです。'); return; } if (!Number.isInteger(index) || index < 0 || index > s.dialogues.length) return; const line = { id: newId(), speaker: '', text: '', stageDirection: '' }; s.dialogues.splice(index, 0, line); renderLines(line.id); changed(); }
function addSceneAt(index) { if (project.scenes.length >= 500) { showError('場面は500件までです。'); return; } if (!Number.isInteger(index) || index < 0 || index > project.scenes.length) return; const s = createScene(); project.scenes.splice(index, 0, s); activeId = s.id; selectedComment = null; render(); focusSceneTitle(s.id); changed(); }
function moveScene(id, offset) { const index = project.scenes.findIndex(s => s.id === id); if (index < 0 || index + offset < 0 || index + offset >= project.scenes.length) return; const s = project.scenes.splice(index, 1)[0]; project.scenes.splice(index + offset, 0, s); render(); changed(); }
async function deleteScene(id) {
  const removed = project.scenes.find(s => s.id === id); if (!removed) return;
  if (!await confirm('この場面を削除しますか？', `「${removed.title || '無題の場面'}」の画像・脚本・コメントをまとめて削除します。Ctrl+Z（⌘Z）で戻せます。`)) return;
  const index = project.scenes.indexOf(removed); if (index < 0) return;
  const previousActiveId = activeId; snapshot(() => { project.scenes.splice(index, 0, removed); activeId = previousActiveId; });
  project.scenes.splice(index, 1); if (activeId === id) activeId = project.scenes[Math.min(index, project.scenes.length - 1)]?.id || null;
  selectedComment = null; render(); changed();
}
async function downloadConte(saving, bytes = makeConte(saving)) {
  const url = URL.createObjectURL(new Blob([bytes], {type:'application/zip'})), a = node('a');
  a.href = url; a.download = `${(saving.title || 'conte').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0,80)}.conte`; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function undo() {
  if (!undoState) return;
  busy(true);
  try { if (undoState.persistent) { clearTimeout(saveTimer); await saveQueue; await restoreNewProjectBackup(undoState.project); }
    if (undoState.restore) undoState.restore(); else { project = undoState.project; activeId = undoState.activeId; }
    undoState = null; selectedComment = null; render(); changed();
  } catch { showError('取り消せませんでした。現在のコンテは保持しています。'); }
  finally { busy(false); }
}
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
  if (e.target.closest?.('input, textarea, [contenteditable]') || document.querySelector('dialog[open]') || !undoState) return;
  e.preventDefault(); void undo();
});
$('new-project').onclick = async () => {
  if (!await confirm('新規コンテを作成しますか？','現在のコンテを.conteとして保存してから新規作成します。ブラウザにも作成前のコンテを保管し、Ctrl+Z（⌘Z）で戻せます。','保存して新規作成')) return;
  $('new-project').disabled = true; busy(true);
  try { const previous = clone(project), previousId = activeId, next = createProject(), bytes=makeConte(previous); clearTimeout(saveTimer); await saveQueue;
    await beginNewProject(previous,previousId,next);
    try { await downloadConte(previous,bytes); } catch(error) { await restoreNewProjectBackup(previous); throw error; }
    undoState = {project:previous,activeId:previousId,persistent:true};
    project=next; activeId=next.scenes[0].id; selectedComment=null; render(); changed();
  } catch { showError('新規作成できませんでした。現在のコンテは保持しています。.conteを保存して再度お試しください。'); }
  finally { $('new-project').disabled = false; busy(false); }
};
$('save-conte').onclick = async () => {
  const saving = clone(project); $('save-conte').disabled = true;
  try {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await downloadConte(saving);
  } catch (error) { showError(error.message, 'save-conte'); }
  finally { $('save-conte').disabled = false; }
};
$('open-conte').onclick = () => $('conte-file').click();
$('conte-file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  $('open-conte').disabled = true;
  try {
    if (!/\.conte$/i.test(file.name)) throw new Error('.conteファイルを選んでください');
    if (file.size > MAX_ARCHIVE_BYTES) throw new Error('ファイル全体は50MBまでです');
    const buffer = new Uint8Array(await file.arrayBuffer());
    const candidate = readConte(buffer);
    for (const s of candidate.scenes) if (s.image?.dataUrl) await decodeImage(s.image.dataUrl);
    if (!await confirm('このファイルを開きますか？', `「${candidate.title || '無題のコンテ'}」に切り替えます。現在の編集はCtrl+Z（⌘Z）で戻せます。`, '開く')) return;
    snapshot(); project = candidate; activeId = project.scenes[0]?.id || null; selectedComment = null; render();
    changed();
  } catch (error) { showError(`読み込みできません：${error.message} 現在のコンテは保持しています。`, 'open-conte'); }
  finally { $('open-conte').disabled = false; }
};
$('show-help').onclick = () => $('help-dialog').showModal(); $('close-help').onclick = () => $('help-dialog').close();
window.addEventListener('beforeunload', e => { if (!loading && savedRevision < revision) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && !loading) { clearTimeout(saveTimer); void persist(); } });
async function start() {
  try { const draft = await loadDraft(); if (draft) project = validateProject(draft); else project = readConte(await (await fetch('./samples/demo.conte')).arrayBuffer()); savedRevision = revision;
    const backup = await loadNewProjectBackup(); if (backup?.newProjectId === project.id) { undoState = {project:validateProject(backup.project),activeId:backup.activeId,persistent:true}; }
  }
  catch { showError('新しいコンテを開きました。自動保存が使えない場合は「.conteを保存」で保管してください。'); }
  activeId = project.scenes[0]?.id || null; loading = false; render();
}
void start();
