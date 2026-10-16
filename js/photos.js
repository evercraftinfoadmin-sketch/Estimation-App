"use strict";

/* Photos for CRM projects (job photos, before / after, reports).
   Photos are too large for localStorage, so they live in IndexedDB
   (database "constructionEstimatorPhotos", store "photos"):
   {id, owner:"project:<id>", name, caption, blob, width, height, createdAt}
   Each photo is resized to at most PHOTO_MAX_SIDE px and saved as JPEG. */

const PHOTO_DB = "constructionEstimatorPhotos";
const PHOTO_STORE = "photos";
const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.82;
const PHOTO_MAX_PER_UPLOAD = 30;

let PHOTO_DB_PROMISE = null;

function photoOwner(type, id){ return `${type}:${id}`; }

function photoDb(){
  if(!PHOTO_DB_PROMISE){
    PHOTO_DB_PROMISE=new Promise((resolve,reject)=>{
      if(!window.indexedDB){ reject(new Error("This browser cannot store photos.")); return; }
      const req=indexedDB.open(PHOTO_DB,1);
      req.onupgradeneeded=()=>{
        const store=req.result.createObjectStore(PHOTO_STORE,{keyPath:"id"});
        store.createIndex("owner","owner");
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    PHOTO_DB_PROMISE.catch(()=>{ PHOTO_DB_PROMISE=null; });
  }
  return PHOTO_DB_PROMISE;
}

function idbRequest(req){
  return new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}

async function photoWrite(fn){
  const db=await photoDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(PHOTO_STORE,"readwrite");
    fn(tx.objectStore(PHOTO_STORE));
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error);
  });
}

async function listPhotos(type, id){
  const db=await photoDb();
  const list=await idbRequest(db.transaction(PHOTO_STORE).objectStore(PHOTO_STORE).index("owner").getAll(photoOwner(type,id)));
  return list.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function getPhoto(photoId){
  const db=await photoDb();
  return idbRequest(db.transaction(PHOTO_STORE).objectStore(PHOTO_STORE).get(photoId));
}

function putPhotos(records){ return photoWrite(store=>records.forEach(r=>store.put(r))); }
function deletePhotoIds(ids){ return photoWrite(store=>ids.forEach(id=>store.delete(id))); }

async function deleteOwnerPhotos(type, id){
  try{
    const list=await listPhotos(type,id);
    if(list.length) await deletePhotoIds(list.map(p=>p.id));
  }catch(e){ /* nothing stored */ }
}

// {owner: count} for every owner that has photos (reads keys only, not the images).
async function photoCountsByOwner(){
  const db=await photoDb();
  return new Promise((resolve,reject)=>{
    const counts={};
    const req=db.transaction(PHOTO_STORE).objectStore(PHOTO_STORE).index("owner").openKeyCursor();
    req.onsuccess=()=>{
      const cursor=req.result;
      if(!cursor){ resolve(counts); return; }
      counts[cursor.key]=(counts[cursor.key]||0)+1;
      cursor.continue();
    };
    req.onerror=()=>reject(req.error);
  });
}

// Removes photos whose CRM project no longer exists.
async function cleanupOrphanPhotos(){
  // With shared cloud data a project missing here can still come back from the cloud: never
  // delete photos automatically then.
  if(typeof cloudActive==="function" && cloudActive()) return;
  try{
    const counts=await photoCountsByOwner();
    const projects=new Set(loadProjects().map(p=>p.id));
    for(const owner of Object.keys(counts)){
      const i=owner.indexOf(":");
      const type=owner.slice(0,i), id=owner.slice(i+1);
      if(!(type==="project" && projects.has(id))) await deleteOwnerPhotos(type,id);
    }
  }catch(e){ /* photos unavailable */ }
}

/* ---------- Image resizing ---------- */

function loadImageFile(file){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{ URL.revokeObjectURL(url); resolve(img); };
    img.onerror=()=>{ URL.revokeObjectURL(url); reject(new Error("Unsupported image")); };
    img.src=url;
  });
}

async function resizeImage(file){
  const img=await loadImageFile(file);
  const scale=Math.min(1,PHOTO_MAX_SIDE/Math.max(img.naturalWidth,img.naturalHeight));
  const width=Math.max(1,Math.round(img.naturalWidth*scale));
  const height=Math.max(1,Math.round(img.naturalHeight*scale));
  const canvas=document.createElement("canvas");
  canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext("2d");
  ctx.fillStyle="#fff";
  ctx.fillRect(0,0,width,height);
  ctx.drawImage(img,0,0,width,height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",PHOTO_QUALITY));
  if(!blob) throw new Error("Could not process image");
  return {blob,width,height};
}

async function addPhotoFiles(type, id, files){
  const images=[...files].filter(f=>f.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f.name));
  if(images.length>PHOTO_MAX_PER_UPLOAD){
    alert(`Please add at most ${PHOTO_MAX_PER_UPLOAD} photos at a time.`);
    return {added:0,failed:0};
  }
  const records=[];
  let failed=0;
  const base=Date.now();
  for(let i=0;i<images.length;i++){
    try{
      const {blob,width,height}=await resizeImage(images[i]);
      records.push({
        id:uid("ph"),
        owner:photoOwner(type,id),
        name:images[i].name,
        caption:"",
        blob,width,height,
        // Keeps the upload order even when several photos are added at once.
        createdAt:new Date(base+i).toISOString()
      });
    }catch(e){ failed++; }
  }
  failed+=files.length-images.length;
  if(records.length) await putPhotos(records);
  return {added:records.length,failed};
}

/* ---------- Gallery component ----------
   <div class="photo-gallery" data-owner-type="estimate|project" data-owner-id="...">
   Rendered by renderPhotoGallery(); all clicks/uploads are handled by one listener. */

const GALLERY_URLS = new WeakMap();

function photoGalleryShell(el){
  if(el.dataset.ready) return;
  el.dataset.ready="1";
  el.innerHTML=`
    <div class="photo-toolbar">
      <label class="btn btn-light photo-add">📷 Add Photos
        <input type="file" accept="image/*" multiple data-photo-input hidden>
      </label>
      <span class="small photo-status" aria-live="polite"></span>
    </div>
    <div class="photo-grid"></div>`;
}

async function renderPhotoGallery(el){
  photoGalleryShell(el);
  const grid=el.querySelector(".photo-grid");
  const type=el.dataset.ownerType, id=el.dataset.ownerId;
  // Old image addresses are released only after their images have left the page.
  // A caption being typed (not saved yet) survives a redraw of the same photos.
  const show=(html,urls=[])=>{
    const old=GALLERY_URLS.get(el)||[];
    const typing=new Map(), focused=document.activeElement;
    grid.querySelectorAll(".photo-caption").forEach(inp=>{ if(inp.value!==inp.defaultValue) typing.set(inp.closest(".photo").dataset.photoId,{value:inp.value,focus:inp===focused}); });
    grid.innerHTML=html;
    typing.forEach((t,pid)=>{
      const inp=grid.querySelector(`.photo[data-photo-id="${CSS.escape(pid)}"] .photo-caption`);
      if(!inp) return;
      inp.value=t.value;
      if(t.focus) inp.focus();
      inp.dispatchEvent(new Event("change",{bubbles:true})); // save it: a restored value raises no change event later
    });
    GALLERY_URLS.set(el,urls);
    old.forEach(u=>URL.revokeObjectURL(u));
  };
  if(!id){
    show(`<div class="photo-empty">${escapeHtml(el.dataset.emptyText || "No photos yet.")}</div>`);
    el.querySelector(".photo-add").hidden=true;
    return [];
  }
  el.querySelector(".photo-add").hidden=false;
  let photos=[];
  try{
    photos=await listPhotos(type,id);
  }catch(e){
    show(`<div class="photo-empty">Photos are not available in this browser.</div>`);
    return [];
  }
  // Ignore a stale render if the gallery switched to another estimate/project meanwhile.
  if(el.dataset.ownerId!==id || el.dataset.ownerType!==type) return photos;
  const urls=photos.map(p=>URL.createObjectURL(p.blob));
  show(photos.length ? photos.map((p,i)=>`
    <figure class="photo" data-photo-id="${escapeHtml(p.id)}">
      <button type="button" class="photo-view" data-photo-action="view" title="View photo">
        <img src="${urls[i]}" alt="${escapeHtml(p.caption || p.name || "Photo")}" loading="lazy">
      </button>
      <button type="button" class="photo-delete" data-photo-action="delete" title="Delete photo" aria-label="Delete photo">✕</button>
      <input type="text" class="photo-caption" data-photo-action="caption" maxlength="120" placeholder="Add a caption" value="${escapeHtml(p.caption)}" aria-label="Photo caption">
    </figure>`).join("")
    : `<div class="photo-empty">No photos yet.</div>`, urls);
  el.dispatchEvent(new CustomEvent("photos-changed",{detail:{count:photos.length},bubbles:true}));
  return photos;
}

function setPhotoGalleryOwner(el, type, id, emptyText){
  el.dataset.ownerType=type;
  el.dataset.ownerId=id || "";
  if(emptyText) el.dataset.emptyText=emptyText;
  return renderPhotoGallery(el);
}

async function handlePhotoUpload(event){
  const input=event.target;
  if(!input.matches("[data-photo-input]")) return;
  const gallery=input.closest(".photo-gallery");
  const files=[...input.files];
  input.value="";
  if(!gallery || !files.length || !gallery.dataset.ownerId) return;
  const status=gallery.querySelector(".photo-status");
  status.textContent=`Adding ${files.length} photo(s)…`;
  try{
    const {added,failed}=await addPhotoFiles(gallery.dataset.ownerType,gallery.dataset.ownerId,files);
    status.textContent="";
    await renderPhotoGallery(gallery);
    if(added) showToast(`${added} photo(s) added.`);
    if(failed) alert(`${failed} file(s) could not be added. Use JPG or PNG photos (on iPhone, choose "Most Compatible" camera format).`);
  }catch(e){
    status.textContent="";
    alert("Could not save the photos. The browser storage may be full.");
  }
}

async function handlePhotoClick(event){
  const btn=event.target.closest("[data-photo-action]");
  const gallery=btn?.closest(".photo-gallery");
  const photoId=btn?.closest(".photo")?.dataset.photoId;
  if(!gallery || !photoId) return;
  if(btn.dataset.photoAction==="view"){
    openPhotoViewer(btn.querySelector("img").src, gallery.querySelector(`.photo[data-photo-id="${CSS.escape(photoId)}"] .photo-caption`).value);
  }else if(btn.dataset.photoAction==="delete"){
    if(!confirm("Delete this photo?")) return;
    await deletePhotoIds([photoId]);
    await renderPhotoGallery(gallery);
    showToast("Photo deleted.");
  }
}

async function handlePhotoCaption(event){
  const input=event.target;
  if(!input.matches('[data-photo-action="caption"]')) return;
  const photo=await getPhoto(input.closest(".photo").dataset.photoId);
  if(!photo) return;
  photo.caption=input.value.trim().slice(0,120);
  await putPhotos([photo]);
}

function openPhotoViewer(src, caption){
  $("photoViewerImg").src=src;
  $("photoViewerCaption").textContent=caption || "";
  openModal("photoViewer");
}

function wirePhotoEvents(){
  document.addEventListener("change",e=>{ handlePhotoUpload(e); handlePhotoCaption(e); });
  document.addEventListener("click",handlePhotoClick);
}
