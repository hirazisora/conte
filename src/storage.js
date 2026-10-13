let database;
async function open() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const req = indexedDB.open('conte-desk', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('drafts');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  return database;
}
export async function loadDraft() {
  const db = await open();
  return new Promise((resolve, reject) => { const request = db.transaction('drafts').objectStore('drafts').get('current'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function saveDraft(project) {
  const db = await open();
  return new Promise((resolve, reject) => { const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(project, 'current'); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}
export async function loadNewProjectBackup() {
  const db = await open();
  return new Promise((resolve, reject) => { const request = db.transaction('drafts').objectStore('drafts').get('before-new'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function beginNewProject(previous, activeId, next) {
  const db = await open();
  return new Promise((resolve, reject) => { const tx = db.transaction('drafts','readwrite'), store = tx.objectStore('drafts'); store.put({project:previous,activeId,newProjectId:next.id},'before-new'); store.put(next,'current'); tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error); });
}
export async function restoreNewProjectBackup(previous) {
  const db = await open();
  return new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts');store.put(previous,'current');store.delete('before-new');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
