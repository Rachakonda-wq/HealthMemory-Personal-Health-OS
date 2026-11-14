
"use strict";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const STORE = "healthMemoryPremium_v1";
const THEME_STORE = "healthMemoryTheme";
const DB_NAME = "HealthMemoryFiles";
const DB_STORE = "files";

let state = {
  records: [], medicines: [], appointments: [], family: [],
  profile: {}, emergency: {}, healthReadings: []
};

let dbPromise = null;
let cameraStream = null;
let scanFiles = [];
let recordFiles = [];
let removedRecordFiles = [];
let viewerUrls = [];
let toastTimer = null;
let currentPage = "dashboard";

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2);
}
function escapeHTML(v) {
  return String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function formatDate(date) {
  if(!date) return "No date";
  const d=new Date(date+"T00:00:00");
  return Number.isNaN(d.getTime())?date:d.toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});
}
function fileSize(bytes) {
  if(!bytes) return "0 KB";
  return bytes<1048576?Math.round(bytes/1024)+" KB":(bytes/1048576).toFixed(2)+" MB";
}
function toast(message) {
  const el=$("#toast");
  if(!el) return;
  el.textContent=message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove("show"),3000);
}
function saveState() {
  try {
    localStorage.setItem(STORE,JSON.stringify(state));
    renderAll();
    return true;
  } catch(e) {
    console.error(e);
    toast("Could not save data. Browser storage may be full.");
    return false;
  }
}
function loadState() {
  try {
    const saved=JSON.parse(localStorage.getItem(STORE)||"{}");
    state={
      records:Array.isArray(saved.records)?saved.records:[],
      medicines:Array.isArray(saved.medicines)?saved.medicines:[],
      appointments:Array.isArray(saved.appointments)?saved.appointments:[],
      family:Array.isArray(saved.family)?saved.family:[],
      profile:saved.profile&&typeof saved.profile==="object"?saved.profile:{},
      emergency:saved.emergency&&typeof saved.emergency==="object"?saved.emergency:{},
      healthReadings:Array.isArray(saved.healthReadings)?saved.healthReadings:[]
    };
  } catch(e) { console.error(e); toast("Could not read saved data."); }
}
function blobToDataURL(blob) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
function dataURLToBlob(data) {
  const parts=data.split(",");
  const mime=parts[0].match(/:(.*?);/);
  if(!mime) throw new Error("Invalid attachment data.");
  const binary=atob(parts[1]);
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes],{type:mime[1]});
}

/* INDEXEDDB */

function openDB() {
  if(dbPromise) return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    if(!window.indexedDB){dbPromise=null;reject(new Error("IndexedDB is unavailable."));return;}
    const request=indexedDB.open(DB_NAME);
    request.onupgradeneeded=()=>{
      const db=request.result;
      let store;
      if(!db.objectStoreNames.contains(DB_STORE)) store=db.createObjectStore(DB_STORE,{keyPath:"id"});
      else store=request.transaction.objectStore(DB_STORE);
      if(!store.indexNames.contains("recordId")) store.createIndex("recordId","recordId",{unique:false});
    };
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
    request.onerror=()=>{dbPromise=null;reject(request.error);};
    request.onblocked=()=>{dbPromise=null;reject(new Error("Close other HealthMemory tabs and retry."));};
  });
  return dbPromise;
}
async function dbPut(file) {
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,"readwrite");
    tx.objectStore(DB_STORE).put(file);
    tx.oncomplete=()=>resolve(file.id);
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error);
  });
}
async function dbGet(id) {
  if(!id)return null;
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(DB_STORE,"readonly").objectStore(DB_STORE).get(id);
    req.onsuccess=()=>resolve(req.result||null);
    req.onerror=()=>reject(req.error);
  });
}
async function dbAll() {
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(DB_STORE,"readonly").objectStore(DB_STORE).getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}
async function dbDelete(id) {
  if(!id)return;
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,"readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
  });
}
async function dbDeleteMany(ids) {
  for(const id of ids){try{await dbDelete(id);}catch(e){console.warn(e);}}
}
async function dbClear() {
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,"readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
  });
}
async function saveBlobFile(file,recordId="") {
  const entry={id:uid(),recordId,name:file.name||"attachment",type:file.type||"application/octet-stream",size:file.size||0,createdAt:new Date().toISOString(),blob:file};
  await dbPut(entry);
  return entry;
}

/* NAVIGATION */

const pageTitles={
  dashboard:"Dashboard",records:"Medical Records",scanner:"Document Scanner",
  medicines:"Medicines",appointments:"Appointments",family:"Family Members",
  timeline:"Health Timeline",profile:"My Profile",settings:"Settings & Backup"
};
function navigate(page) {
  if(!pageTitles[page])return;
  currentPage=page;
  $$(".page").forEach(el=>el.classList.toggle("active",el.id==="page-"+page));
  $$(".nav-btn").forEach(el=>el.classList.toggle("active",el.dataset.page===page));
  $("#pageTitle").textContent=pageTitles[page];
  window.scrollTo({top:0,behavior:"smooth"});
  if(page==="settings")refreshStorage();
  if(page==="dashboard")drawHealthCharts();
}
document.addEventListener("click",e=>{
  const nav=e.target.closest("[data-page]");
  if(nav)navigate(nav.dataset.page);
  const go=e.target.closest("[data-go]");
  if(go)navigate(go.dataset.go);
});

/* MEDICAL RECORDS */

function openRecordForm(record=null) {
  $("#recordPanel").classList.remove("hidden");
  $("#recordPanel").classList.add("show");
  $("#recordFormTitle").textContent=record?"Edit medical record":"Add medical record";
  $("#recordId").value=record?.id||"";
  $("#recordTitle").value=record?.title||"";
  $("#recordType").value=record?.type||"Lab Report";
  $("#recordDate").value=record?.date||today();
  $("#recordDoctor").value=record?.doctor||"";
  $("#recordNotes").value=record?.notes||"";
  $("#recordAttachment").value="";
  recordFiles=[];
  removedRecordFiles=[];
  if(record){
    recordFiles=(record.attachments||[]).map(id=>({id,name:"Loading attachment...",isNew:false}));
    loadRecordAttachmentNames(record.attachments||[]);
  }
  renderRecordFileList();
  $("#recordPanel").scrollIntoView({behavior:"smooth"});
}
async function loadRecordAttachmentNames(ids) {
  for(const id of ids){
    try{const file=await dbGet(id);const item=recordFiles.find(f=>f.id===id);if(item&&file)item.name=file.name;}catch(e){console.warn(e);}
  }
  renderRecordFileList();
}
function closeRecordForm() {
  $("#recordPanel").classList.add("hidden");
  $("#recordForm").reset();
  recordFiles=[];removedRecordFiles=[];
  $("#recordFileList").innerHTML="";
}
function renderRecordFileList() {
  $("#recordFileList").innerHTML=recordFiles.map((f,i)=>`<div class="file-chip">📎 ${escapeHTML(f.name)} <button type="button" data-remove-record-file="${i}">×</button></div>`).join("");
}
$("#recordAttachment").addEventListener("change",e=>{
  [...e.target.files].forEach(file=>recordFiles.push({name:file.name,file,isNew:true}));
  renderRecordFileList();e.target.value="";
});
$("#recordFileList").addEventListener("click",e=>{
  const b=e.target.closest("[data-remove-record-file]");
  if(!b)return;
  const i=Number(b.dataset.removeRecordFile),f=recordFiles[i];
  if(f&&!f.isNew&&f.id)removedRecordFiles.push(f.id);
  recordFiles.splice(i,1);renderRecordFileList();
});
async function saveRecord(e) {
  e.preventDefault();
  const title=$("#recordTitle").value.trim();
  if(!title){toast("Enter a record title.");return;}
  const id=$("#recordId").value||uid();
  const old=state.records.find(r=>r.id===id);
  const previous=state.records;
  const ids=[],newIds=[];
  try{
    for(const f of recordFiles){
      if(f.isNew){const saved=await saveBlobFile(f.file,id);ids.push(saved.id);newIds.push(saved.id);}
      else if(f.id)ids.push(f.id);
    }
    const record={id,title,type:$("#recordType").value,date:$("#recordDate").value||today(),doctor:$("#recordDoctor").value.trim(),notes:$("#recordNotes").value.trim(),attachments:ids,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    state.records=old?state.records.map(r=>r.id===id?record:r):[record,...state.records];
    if(!saveState()){state.records=previous;await dbDeleteMany(newIds);return;}
    const used=new Set(state.records.flatMap(r=>r.attachments||[]));
    await dbDeleteMany(removedRecordFiles.filter(fid=>!used.has(fid)));
    closeRecordForm();toast("Medical record saved.");
  }catch(err){console.error(err);await dbDeleteMany(newIds);toast("Attachment save failed: "+err.message);}
}
$("#recordForm").addEventListener("submit",saveRecord);
$("#newRecord").addEventListener("click",()=>openRecordForm());
$("#cancelRecord").addEventListener("click",closeRecordForm);
$("#cancelRecord2").addEventListener("click",closeRecordForm);

function renderRecords() {
  const q=$("#recordSearch").value.toLowerCase(),type=$("#recordFilter").value;
  const list=state.records.filter(r=>(!type||r.type===type)&&[r.title,r.doctor,r.notes,r.type].join(" ").toLowerCase().includes(q));
  $("#recordsList").innerHTML=list.length?list.map(r=>`
    <article class="record-card"><h3>▤ ${escapeHTML(r.title)}</h3>
    <p>${escapeHTML(r.doctor||"No doctor / hospital")}</p>
    <div class="record-meta"><span class="pill">${escapeHTML(r.type)}</span><span class="pill">${formatDate(r.date)}</span></div>
    <p>${escapeHTML(r.notes||"No notes added")}</p><p>📎 ${(r.attachments||[]).length} attachment(s)</p>
    <div class="card-actions"><button class="small-btn" data-view-record="${escapeHTML(r.id)}">View files</button><button class="small-btn" data-edit-record="${escapeHTML(r.id)}">Edit</button><button class="small-btn delete" data-delete-record="${escapeHTML(r.id)}">Delete</button></div></article>`).join(""):`<div class="empty-state">No medical records found. Add your first record.</div>`;
}
$("#recordSearch").addEventListener("input",renderRecords);
$("#recordFilter").addEventListener("change",renderRecords);
$("#recordsList").addEventListener("click",async e=>{
  const edit=e.target.closest("[data-edit-record]"),del=e.target.closest("[data-delete-record]"),view=e.target.closest("[data-view-record]");
  if(edit)openRecordForm(state.records.find(r=>r.id===edit.dataset.editRecord));
  if(del){
    const id=del.dataset.deleteRecord;
    if(!confirm("Delete this medical record and its attachments?"))return;
    const record=state.records.find(r=>r.id===id),old=state.records;
    state.records=state.records.filter(r=>r.id!==id);
    if(!saveState()){state.records=old;return;}
    const used=new Set(state.records.flatMap(r=>r.attachments||[]));
    await dbDeleteMany((record?.attachments||[]).filter(fid=>!used.has(fid)));
    toast("Record deleted.");
  }
  if(view)await viewAttachments(state.records.find(r=>r.id===view.dataset.viewRecord));
});

/* ATTACHMENT VIEWER */

function clearViewerUrls(){viewerUrls.forEach(u=>URL.revokeObjectURL(u));viewerUrls=[];}
function closeViewer(){clearViewerUrls();$("#viewerModal").classList.remove("show");$("#viewerContent").innerHTML="";$("#viewerDownload").style.display="none";}
async function viewAttachments(record) {
  if(!record)return;
  clearViewerUrls();$("#viewerTitle").textContent=record.title;
  const content=$("#viewerContent");content.textContent="Loading attachments...";
  $("#viewerDownload").style.display="none";$("#viewerModal").classList.add("show");
  const ids=record.attachments||[];
  if(!ids.length){content.innerHTML="<p class='empty-state'>No attachments saved for this record.</p>";return;}
  content.innerHTML="";
  for(const id of ids){
    try{
      const f=await dbGet(id);if(!f)continue;
      const blob=f.blob||f.file;if(!blob)continue;
      const url=URL.createObjectURL(blob);viewerUrls.push(url);
      const item=document.createElement("div");item.className="record-card";
      const title=document.createElement("h3");title.textContent=f.name;item.appendChild(title);
      if((f.type||blob.type).startsWith("image/")){
        const img=document.createElement("img");img.src=url;img.alt=f.name;item.appendChild(img);
      }else if((f.type||blob.type).includes("pdf")){
        const frame=document.createElement("iframe");frame.src=url;frame.title=f.name;item.appendChild(frame);
      }else{const p=document.createElement("p");p.textContent="Preview unavailable. Download the file.";item.appendChild(p);}
      const a=document.createElement("a");a.className="btn secondary";a.textContent="Download "+f.name;a.href=url;a.download=f.name;item.appendChild(a);
      content.appendChild(item);
    }catch(err){console.error(err);}
  }
  if(!content.children.length)content.innerHTML="<p class='empty-state'>No readable attachments were found.</p>";
}
function viewBlob(blob,name) {
  clearViewerUrls();const url=URL.createObjectURL(blob);viewerUrls.push(url);
  $("#viewerTitle").textContent=name;$("#viewerContent").innerHTML="";
  $("#viewerDownload").href=url;$("#viewerDownload").download=name;$("#viewerDownload").style.display="inline-flex";
  if(blob.type.startsWith("image/")){const img=document.createElement("img");img.src=url;img.alt=name;$("#viewerContent").appendChild(img);}
  else if(blob.type==="application/pdf"){const frame=document.createElement("iframe");frame.src=url;frame.title=name;$("#viewerContent").appendChild(frame);}
  else $("#viewerContent").textContent="Preview unavailable. Use Download.";
  $("#viewerModal").classList.add("show");
}
$("#closeViewer").addEventListener("click",closeViewer);
$("#closeViewer2").addEventListener("click",closeViewer);
$("#viewerModal").addEventListener("click",e=>{if(e.target.id==="viewerModal")closeViewer();});
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeViewer();});

/* CAMERA AND DOCUMENT SCANNER */

function showCamera(){$("#cameraPreview").style.display="block";$("#cameraPlaceholder").style.display="none";}
function hideCamera(){$("#cameraPreview").style.display="none";$("#cameraPlaceholder").style.display="flex";}
function stopCamera() {
  if(cameraStream){cameraStream.getTracks().forEach(t=>t.stop());cameraStream=null;}
  const video=$("#cameraPreview");
  if(video){video.pause();video.srcObject=null;hideCamera();}
  if($("#capturePhoto"))$("#capturePhoto").disabled=true;
}
async function startCamera() {
  if(!navigator.mediaDevices?.getUserMedia){toast("Camera requires HTTPS or localhost.");return;}
  stopCamera();$("#startCamera").disabled=true;
  try{
    cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
    const video=$("#cameraPreview");video.srcObject=cameraStream;video.muted=true;showCamera();await video.play();
    $("#capturePhoto").disabled=false;toast("Camera opened. Capture your document.");
  }catch(err){
    console.error(err);stopCamera();
    toast(err.name==="NotAllowedError"?"Camera permission denied.":err.name==="NotFoundError"?"No camera found.":"Could not open camera: "+err.message);
  }finally{$("#startCamera").disabled=false;}
}
$("#startCamera").addEventListener("click",startCamera);
$("#stopCamera").addEventListener("click",stopCamera);
$("#capturePhoto").addEventListener("click",()=>{
  const video=$("#cameraPreview");
  if(!cameraStream||!video.videoWidth){toast("Open the camera first.");return;}
  const canvas=$("#cameraCanvas");canvas.width=video.videoWidth;canvas.height=video.videoHeight;
  canvas.getContext("2d").drawImage(video,0,0,canvas.width,canvas.height);
  canvas.toBlob(blob=>{
    if(!blob){toast("Photo capture failed.");return;}
    const file=new File([blob],"Camera_"+Date.now()+".jpg",{type:"image/jpeg"});
    scanFiles.push({id:uid(),name:file.name,type:file.type,size:file.size,file,isImage:true,source:"camera",previewURL:URL.createObjectURL(file)});
    renderScanFiles();toast("Photo captured.");
  },"image/jpeg",.92);
});
$("#scanUpload").addEventListener("change",e=>{
  let count=0;
  [...e.target.files].forEach(file=>{
    if(!file.type.startsWith("image/")&&file.type!=="application/pdf"){toast("Unsupported file: "+file.name);return;}
    if(file.size>20*1024*1024){toast("File exceeds 20 MB: "+file.name);return;}
    const isImage=file.type.startsWith("image/");
    scanFiles.push({id:uid(),name:file.name,type:file.type,size:file.size,file,isImage,source:"upload",previewURL:isImage?URL.createObjectURL(file):null});count++;
  });
  e.target.value="";renderScanFiles();if(count)toast(count+" file(s) added.");
});
function renderScanFiles() {
  $("#scanCount").textContent=scanFiles.length;
  $("#scanFiles").innerHTML=scanFiles.length?scanFiles.map((f,i)=>`
    <div class="scan-item">${f.isImage?`<img class="scan-thumb" src="${f.previewURL||""}" alt="Scanned page">`:`<div class="scan-thumb">📄</div>`}
    <div class="scan-info"><strong>${escapeHTML(f.name)}</strong><small>${fileSize(f.size)} · ${f.source==="camera"?"Camera capture":"Uploaded file"}</small></div>
    <button type="button" data-preview-scan="${i}">◉</button><button type="button" data-remove-scan="${i}">×</button></div>`).join(""):`<div class="empty-state">No scanned pages yet. Capture a photo or upload a file.</div>`;
}
$("#scanFiles").addEventListener("click",e=>{
  const rem=e.target.closest("[data-remove-scan]"),prev=e.target.closest("[data-preview-scan]");
  if(rem){const i=Number(rem.dataset.removeScan),f=scanFiles[i];if(f?.previewURL)URL.revokeObjectURL(f.previewURL);scanFiles.splice(i,1);renderScanFiles();}
  if(prev){const f=scanFiles[Number(prev.dataset.previewScan)];if(f?.file)viewBlob(f.file,f.name);}
});
$("#clearScan").addEventListener("click",()=>{
  if(!scanFiles.length){toast("There are no scanned pages.");return;}
  if(!confirm("Remove all scanned pages?"))return;
  scanFiles.forEach(f=>{if(f.previewURL)URL.revokeObjectURL(f.previewURL);});
  scanFiles=[];renderScanFiles();toast("Scanner pages cleared.");
});

/* PDF GENERATION */

async function generateScanPDF() {
  const images=scanFiles.filter(f=>f.isImage);
  if(!images.length)throw new Error("Add at least one image page to create a PDF.");
  if(!window.jspdf)throw new Error("PDF library unavailable. Check your internet connection.");
  const {jsPDF}=window.jspdf;
  const pdf=new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
  let added=false;
  for(const f of images){
    const data=await blobToDataURL(f.file),img=new Image();
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error("Could not read "+f.name));img.src=data;});
    if(added)pdf.addPage();added=true;
    const ratio=Math.min(190/img.width,277/img.height);
    const w=img.width*ratio,h=img.height*ratio;
    pdf.addImage(data,f.type==="image/png"?"PNG":"JPEG",(210-w)/2,(297-h)/2,w,h);
  }
  return pdf;
}
$("#downloadScan").addEventListener("click",async()=>{
  if(!scanFiles.length){toast("Capture or upload files first.");return;}
  try{
    const images=scanFiles.filter(f=>f.isImage),pdfs=scanFiles.filter(f=>f.type==="application/pdf");
    if(images.length){const pdf=await generateScanPDF();pdf.save("HealthMemory_Scan_"+today()+".pdf");toast("Scanned image pages downloaded as PDF.");}
    else if(pdfs.length===1){
      const f=pdfs[0],url=URL.createObjectURL(f.file),a=document.createElement("a");
      a.href=url;a.download=f.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }else toast("Multiple existing PDFs cannot be merged by this scanner.");
  }catch(err){console.error(err);toast(err.message);}
});
$("#saveScanRecord").addEventListener("click",async()=>{
  if(!scanFiles.length){toast("Capture or upload files first.");return;}
  const title=prompt("Enter a title for this medical record:","Scanned Medical Document");
  if(!title?.trim())return;
  const id=uid(),ids=[],newIds=[];
  try{
    for(const f of scanFiles){const saved=await saveBlobFile(f.file,id);ids.push(saved.id);newIds.push(saved.id);}
    if(scanFiles.some(f=>f.isImage)){
      try{
        const pdf=await generateScanPDF(),blob=pdf.output("blob");
        const pdfFile=new File([blob],title.replace(/[^\w-]+/g,"_")+"_Scan.pdf",{type:"application/pdf"});
        const saved=await saveBlobFile(pdfFile,id);ids.push(saved.id);newIds.push(saved.id);
      }catch(err){console.warn(err);}
    }
    const old=state.records;
    state.records.unshift({id,title:title.trim(),type:"Scan / Imaging",date:today(),doctor:"",notes:"Saved from Document Scanner.",attachments:ids,createdAt:new Date().toISOString()});
    if(!saveState()){state.records=old;await dbDeleteMany(newIds);return;}
    toast("Scanner files saved to Medical Records.");navigate("records");
  }catch(err){console.error(err);await dbDeleteMany(newIds);toast("Could not save scanner files: "+err.message);}
});

/* MEDICINES */

function openMedicineForm(m=null) {
  $("#medicinePanel").classList.remove("hidden");
  $("#medicineFormTitle").textContent=m?"Edit medicine":"Add medicine";
  $("#medicineId").value=m?.id||"";$("#medicineName").value=m?.name||"";
  $("#medicineStrength").value=m?.strength||"";$("#medicinePurpose").value=m?.purpose||"";
  $("#medicineStart").value=m?.start||today();$("#medicineDuration").value=m?.duration||"";
  $("#medicineInstructions").value=m?.instructions||"";
  const s=m?.schedule||[];
  $("#medicineMorning").checked=s.includes("Morning");
  $("#medicineAfternoon").checked=s.includes("Afternoon");
  $("#medicineEvening").checked=s.includes("Evening");
  $("#medicineNight").checked=s.includes("Night");
  $("#medicinePanel").scrollIntoView({behavior:"smooth"});
}
function closeMedicineForm(){$("#medicinePanel").classList.add("hidden");$("#medicineForm").reset();$("#medicineId").value="";}
$("#newMedicine").addEventListener("click",()=>openMedicineForm());
$("#cancelMedicine").addEventListener("click",closeMedicineForm);
$("#cancelMedicine2").addEventListener("click",closeMedicineForm);
$("#medicineForm").addEventListener("submit",e=>{
  e.preventDefault();
  const id=$("#medicineId").value||uid(),schedule=[];
  ["Morning","Afternoon","Evening","Night"].forEach(t=>{
    const key="medicine"+t;
    if($("#"+key).checked)schedule.push(t);
  });
  const old=state.medicines,previous=old.find(m=>m.id===id);
  const m={id,name:$("#medicineName").value.trim(),strength:$("#medicineStrength").value.trim(),purpose:$("#medicinePurpose").value.trim(),start:$("#medicineStart").value,duration:$("#medicineDuration").value,instructions:$("#medicineInstructions").value.trim(),schedule,createdAt:previous?.createdAt||new Date().toISOString()};
  state.medicines=previous?old.map(x=>x.id===id?m:x):[m,...old];
  if(!saveState()){state.medicines=old;return;}
  closeMedicineForm();toast("Medicine saved.");
});
function renderMedicines() {
  const q=$("#medicineSearch").value.toLowerCase();
  const list=state.medicines.filter(m=>[m.name,m.strength,m.purpose,m.instructions,(m.schedule||[]).join(" ")].join(" ").toLowerCase().includes(q));
  $("#medicinesList").innerHTML=list.length?list.map(m=>`
    <article class="record-card"><h3>♧ ${escapeHTML(m.name)}</h3><p>${escapeHTML(m.strength||"Dosage not specified")}</p>
    <div class="record-meta"><span class="pill">${escapeHTML(m.purpose||"Medicine")}</span></div>
    <p>Schedule: ${escapeHTML((m.schedule||[]).join(", ")||"Not specified")}</p>
    <p>${escapeHTML(m.instructions||"")}</p><p>Start: ${formatDate(m.start)}${m.duration?" · "+escapeHTML(m.duration)+" days":""}</p>
    <div class="card-actions"><button class="small-btn" data-edit-medicine="${m.id}">Edit</button><button class="small-btn delete" data-delete-medicine="${m.id}">Delete</button></div></article>`).join(""):`<div class="empty-state">No medicines added.</div>`;
}
$("#medicineSearch").addEventListener("input",renderMedicines);
$("#medicinesList").addEventListener("click",e=>{
  const edit=e.target.closest("[data-edit-medicine]"),del=e.target.closest("[data-delete-medicine]");
  if(edit)openMedicineForm(state.medicines.find(m=>m.id===edit.dataset.editMedicine));
  if(del&&confirm("Delete this medicine?")){
    const old=state.medicines;state.medicines=old.filter(m=>m.id!==del.dataset.deleteMedicine);
    if(!saveState()){state.medicines=old;return;}toast("Medicine deleted.");
  }
});

/* APPOINTMENTS */

function openAppointmentForm(a=null) {
  $("#appointmentPanel").classList.remove("hidden");
  $("#appointmentFormTitle").textContent=a?"Edit appointment":"Add appointment";
  $("#appointmentId").value=a?.id||"";
  $("#appointmentDoctor").value=a?.doctor||"";
  $("#appointmentSpecialty").value=a?.specialty||"";
  $("#appointmentDate").value=a?.date||today();
  $("#appointmentTime").value=a?.time||"";
  $("#appointmentLocation").value=a?.location||"";
  $("#appointmentStatus").value=a?.status||"Upcoming";
  $("#appointmentNotes").value=a?.notes||"";
  $("#appointmentPanel").scrollIntoView({behavior:"smooth"});
}
function closeAppointmentForm(){$("#appointmentPanel").classList.add("hidden");$("#appointmentForm").reset();$("#appointmentId").value="";}
$("#newAppointment").addEventListener("click",()=>openAppointmentForm());
$("#cancelAppointment").addEventListener("click",closeAppointmentForm);
$("#cancelAppointment2").addEventListener("click",closeAppointmentForm);
$("#appointmentForm").addEventListener("submit",e=>{
  e.preventDefault();const id=$("#appointmentId").value||uid(),old=state.appointments;
  const a={id,doctor:$("#appointmentDoctor").value.trim(),specialty:$("#appointmentSpecialty").value.trim(),date:$("#appointmentDate").value,time:$("#appointmentTime").value,location:$("#appointmentLocation").value.trim(),status:$("#appointmentStatus").value,notes:$("#appointmentNotes").value.trim()};
  state.appointments=old.some(x=>x.id===id)?old.map(x=>x.id===id?a:x):[a,...old];
  if(!saveState()){state.appointments=old;return;}
  closeAppointmentForm();toast("Appointment saved.");
});
function renderAppointments() {
  const list=[...state.appointments].sort((a,b)=>(a.date||"").localeCompare(b.date||""));
  $("#appointmentsList").innerHTML=list.length?list.map(a=>`
    <article class="record-card"><h3>◷ ${escapeHTML(a.doctor)}</h3><p>${escapeHTML(a.specialty||"Appointment")}</p>
    <div class="record-meta"><span class="pill">${formatDate(a.date)}</span><span class="pill">${escapeHTML(a.status)}</span></div>
    <p>${escapeHTML(a.time||"Time not specified")} · ${escapeHTML(a.location||"Location not specified")}</p><p>${escapeHTML(a.notes||"")}</p>
    <div class="card-actions"><button class="small-btn" data-edit-appointment="${a.id}">Edit</button><button class="small-btn delete" data-delete-appointment="${a.id}">Delete</button></div></article>`).join(""):`<div class="empty-state">No appointments added.</div>`;
}
$("#appointmentsList").addEventListener("click",e=>{
  const edit=e.target.closest("[data-edit-appointment]"),del=e.target.closest("[data-delete-appointment]");
  if(edit)openAppointmentForm(state.appointments.find(a=>a.id===edit.dataset.editAppointment));
  if(del&&confirm("Delete appointment?")){
    const old=state.appointments;state.appointments=old.filter(a=>a.id!==del.dataset.deleteAppointment);
    if(!saveState()){state.appointments=old;return;}toast("Appointment deleted.");
  }
});

/* FAMILY */

function openFamilyForm(f=null) {
  $("#familyPanel").classList.remove("hidden");
  $("#familyFormTitle").textContent=f?"Edit member":"Add family member";
  $("#familyId").value=f?.id||"";$("#familyName").value=f?.name||"";
  $("#familyRelation").value=f?.relation||"";$("#familyBirth").value=f?.birth||"";
  $("#familyBlood").value=f?.blood||"";$("#familyNotes").value=f?.notes||"";
  $("#familyPanel").scrollIntoView({behavior:"smooth"});
}
function closeFamilyForm(){$("#familyPanel").classList.add("hidden");$("#familyForm").reset();$("#familyId").value="";}
$("#newFamily").addEventListener("click",()=>openFamilyForm());
$("#cancelFamily").addEventListener("click",closeFamilyForm);
$("#cancelFamily2").addEventListener("click",closeFamilyForm);
$("#familyForm").addEventListener("submit",e=>{
  e.preventDefault();const id=$("#familyId").value||uid(),old=state.family;
  const f={id,name:$("#familyName").value.trim(),relation:$("#familyRelation").value.trim(),birth:$("#familyBirth").value,blood:$("#familyBlood").value,notes:$("#familyNotes").value.trim()};
  state.family=old.some(x=>x.id===id)?old.map(x=>x.id===id?f:x):[f,...old];
  if(!saveState()){state.family=old;return;}
  closeFamilyForm();toast("Family member saved.");
});
function renderFamily() {
  $("#familyList").innerHTML=state.family.length?state.family.map(f=>`
    <article class="record-card"><h3>♙ ${escapeHTML(f.name)}</h3><p>${escapeHTML(f.relation||"Family member")}</p>
    <div class="record-meta"><span class="pill">${escapeHTML(f.blood||"Blood group unknown")}</span></div>
    <p>Date of birth: ${formatDate(f.birth)}</p><p>${escapeHTML(f.notes||"")}</p>
    <div class="card-actions"><button class="small-btn" data-edit-family="${f.id}">Edit</button><button class="small-btn delete" data-delete-family="${f.id}">Delete</button></div></article>`).join(""):`<div class="empty-state">No family members added.</div>`;
}
$("#familyList").addEventListener("click",e=>{
  const edit=e.target.closest("[data-edit-family]"),del=e.target.closest("[data-delete-family]");
  if(edit)openFamilyForm(state.family.find(f=>f.id===edit.dataset.editFamily));
  if(del&&confirm("Delete family member?")){
    const old=state.family;state.family=old.filter(f=>f.id!==del.dataset.deleteFamily);
    if(!saveState()){state.family=old;return;}toast("Family member deleted.");
  }
});

/* PROFILE AND EMERGENCY */

function loadProfile() {
  const p=state.profile||{},em=state.emergency||{};
  $("#profileName").value=p.name||"";$("#profileDOB").value=p.dob||"";
  $("#profileGender").value=p.gender||"";$("#profileBlood").value=p.blood||"";
  $("#profilePhone").value=p.phone||"";$("#profileEmail").value=p.email||"";
  $("#profileAddress").value=p.address||"";
  $("#emergencyName").value=em.name||"";$("#emergencyPhone").value=em.phone||"";
  $("#emergencyAllergies").value=em.allergies||"";$("#emergencyConditions").value=em.conditions||"";
  $("#emergencyNotes").value=em.notes||"";
  $("#healthReadingDate").value=today();
  renderHealthReadings();
}
$("#profileForm").addEventListener("submit",e=>{
  e.preventDefault();const old=state.profile;
  state.profile={name:$("#profileName").value.trim(),dob:$("#profileDOB").value,gender:$("#profileGender").value,blood:$("#profileBlood").value,phone:$("#profilePhone").value.trim(),email:$("#profileEmail").value.trim(),address:$("#profileAddress").value.trim()};
  if(!saveState()){state.profile=old;return;}toast("Profile saved.");
});
$("#emergencyForm").addEventListener("submit",e=>{
  e.preventDefault();const old=state.emergency;
  state.emergency={name:$("#emergencyName").value.trim(),phone:$("#emergencyPhone").value.trim(),allergies:$("#emergencyAllergies").value.trim(),conditions:$("#emergencyConditions").value.trim(),notes:$("#emergencyNotes").value.trim()};
  if(!saveState()){state.emergency=old;return;}toast("Emergency information saved.");
});

/* HEALTH READINGS: ADD, EDIT, DELETE */

function resetHealthReadingForm() {
  $("#healthReadingForm").reset();
  $("#healthReadingId").value="";
  $("#healthReadingDate").value=today();
  $("#saveHealthReading").textContent="Save Reading";
}
$("#cancelHealthReading").addEventListener("click",resetHealthReadingForm);

$("#healthReadingForm").addEventListener("submit",e=>{
  e.preventDefault();
  const systolic=Number($("#healthSystolic").value);
  const diastolic=Number($("#healthDiastolic").value);
  const heartRate=Number($("#healthHeartRate").value);
  const date=$("#healthReadingDate").value;
  if(systolic<70||systolic>250||diastolic<40||diastolic>150||heartRate<30||heartRate>220){
    toast("Please check the reading values and allowed input ranges.");return;
  }
  if(systolic<=diastolic){toast("Systolic BP should be greater than diastolic BP.");return;}
  if(!date){toast("Select the reading date.");return;}
  const id=$("#healthReadingId").value||uid();
  const old=state.healthReadings;
  const existing=old.find(r=>r.id===id);
  const reading={id,date,systolic,diastolic,heartRate,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
  state.healthReadings=existing?old.map(r=>r.id===id?reading:r):[reading,...old];
  if(!saveState()){state.healthReadings=old;return;}
  resetHealthReadingForm();
  renderHealthReadings();
  drawHealthCharts();
  toast(existing?"Health reading updated.":"Health reading saved.");
});

function renderHealthReadings() {
  const list=[...(state.healthReadings||[])].sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  $("#healthReadingsList").innerHTML=list.length?list.map(r=>`
    <article class="health-reading-card">
      <strong>${formatDate(r.date)}</strong>
      <p>Blood pressure: <b>${escapeHTML(r.systolic)}/${escapeHTML(r.diastolic)} mmHg</b></p>
      <p>Heart rate: <b>${escapeHTML(r.heartRate)} BPM</b></p>
      <div class="health-reading-actions">
        <button class="small-btn" data-edit-reading="${escapeHTML(r.id)}">Edit</button>
        <button class="small-btn delete" data-delete-reading="${escapeHTML(r.id)}">Delete</button>
      </div>
    </article>`).join(""):`<div class="empty-state">No health readings added yet.</div>`;
}
$("#healthReadingsList").addEventListener("click",e=>{
  const edit=e.target.closest("[data-edit-reading]"),del=e.target.closest("[data-delete-reading]");
  if(edit){
    const r=state.healthReadings.find(x=>x.id===edit.dataset.editReading);
    if(!r)return;
    $("#healthReadingId").value=r.id;$("#healthSystolic").value=r.systolic;
    $("#healthDiastolic").value=r.diastolic;$("#healthHeartRate").value=r.heartRate;
    $("#healthReadingDate").value=r.date;$("#saveHealthReading").textContent="Update Reading";
    $("#healthReadingForm").scrollIntoView({behavior:"smooth"});
  }
  if(del&&confirm("Delete this health reading?")){
    const old=state.healthReadings;
    state.healthReadings=old.filter(r=>r.id!==del.dataset.deleteReading);
    if(!saveState()){state.healthReadings=old;return;}
    renderHealthReadings();drawHealthCharts();toast("Health reading deleted.");
  }
});

/* TIMELINE */

function renderTimeline() {
  const events=[
    ...state.records.map(r=>({date:r.date,title:r.title,detail:r.type,icon:"▤"})),
    ...state.appointments.map(a=>({date:a.date,title:a.doctor,detail:"Appointment · "+a.status,icon:"◷"})),
    ...(state.healthReadings||[]).map(r=>({date:r.date,title:"Health reading",detail:`BP ${r.systolic}/${r.diastolic} mmHg · HR ${r.heartRate} BPM`,icon:"♥"}))
  ].sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  $("#timelineList").innerHTML=events.length?events.map(e=>`
    <div class="timeline-item"><strong>${escapeHTML(e.icon+" "+e.title)}</strong><small>${formatDate(e.date)} · ${escapeHTML(e.detail)}</small></div>`).join(""):`<div class="empty-state">Your health timeline will appear here.</div>`;
}

/* DASHBOARD */

function renderDashboard() {
  $("#statRecords").textContent=state.records.length;
  $("#statMedicines").textContent=state.medicines.length;
  $("#statAppointments").textContent=state.appointments.filter(a=>a.status==="Upcoming"&&a.date>=today()).length;
  $("#statFamily").textContent=state.family.length;
  $("#welcomeName").textContent=(state.profile.name||"there").split(" ")[0];
  $("#sidebarName").textContent=state.profile.name||"My Health";

  const records=state.records.slice(0,4);
  $("#recentRecords").innerHTML=records.length?records.map(r=>`
    <div class="list-item"><div class="list-icon">▤</div><div class="item-main"><strong>${escapeHTML(r.title)}</strong><small>${formatDate(r.date)} · ${escapeHTML(r.type)}</small></div></div>`).join(""):`<div class="empty-state">No records saved yet.</div>`;

  const appointments=state.appointments.filter(a=>a.status==="Upcoming"&&a.date>=today()).sort((a,b)=>(a.date||"").localeCompare(b.date||"")).slice(0,4);
  $("#upcomingAppointments").innerHTML=appointments.length?appointments.map(a=>`
    <div class="list-item"><div class="list-icon">◷</div><div class="item-main"><strong>${escapeHTML(a.doctor)}</strong><small>${formatDate(a.date)} ${escapeHTML(a.time||"")}</small></div></div>`).join(""):`<div class="empty-state">No upcoming appointments.</div>`;

  $("#dashboardMedicines").innerHTML=state.medicines.length?state.medicines.map(m=>`
    <div class="list-item"><div class="list-icon">♧</div><div class="item-main"><strong>${escapeHTML(m.name||"Unnamed medicine")}</strong><small>${escapeHTML(m.strength||"Dosage not specified")}${m.purpose?" · "+escapeHTML(m.purpose):""}</small><small>Schedule: ${escapeHTML((m.schedule||[]).join(", ")||"Not specified")}${m.duration?" · "+escapeHTML(m.duration)+" days":""}</small>${m.instructions?`<small>${escapeHTML(m.instructions)}</small>`:""}</div></div>`).join(""):`<div class="empty-state">No medicines added yet.</div>`;
  drawHealthCharts();
}
function renderAll() {
  renderDashboard();renderRecords();renderMedicines();renderAppointments();
  renderFamily();renderTimeline();renderHealthReadings();
}

/* COMBINED HEALTH OVERVIEW LINE CHART */

function drawHealthCharts(){drawHealthOverviewChart();}

function drawHealthOverviewChart() {
  const canvas=$("#healthOverviewChart"),empty=$("#healthChartEmpty");
  if(!canvas||!empty)return;
  const readings=[...(state.healthReadings||[])].sort((a,b)=>(a.date||"").localeCompare(b.date||"")).slice(-12);
  if(!readings.length){
    canvas.style.display="none";empty.style.display="block";return;
  }
  canvas.style.display="block";empty.style.display="none";

  const width=Math.max(280,canvas.clientWidth||600);
  const height=Math.max(230,canvas.clientHeight||310);
  const ratio=Math.min(window.devicePixelRatio||1,2);
  canvas.width=width*ratio;canvas.height=height*ratio;
  const ctx=canvas.getContext("2d");
  ctx.setTransform(ratio,0,0,ratio,0,0);
  ctx.clearRect(0,0,width,height);

  const styles=getComputedStyle(document.body);
  const text=styles.getPropertyValue("--muted").trim()||"#71818b";
  const grid=styles.getPropertyValue("--line").trim()||"#e5edf0";
  const pad={left:48,right:45,top:25,bottom:48};
  const chartW=width-pad.left-pad.right;
  const chartH=height-pad.top-pad.bottom;

  const bpValues=readings.flatMap(r=>[Number(r.systolic),Number(r.diastolic)]);
  const bpMin=Math.max(0,Math.floor((Math.min(...bpValues)-10)/10)*10);
  const bpMax=Math.ceil((Math.max(...bpValues)+10)/10)*10;
  const hrValues=readings.map(r=>Number(r.heartRate));
  const hrMin=Math.max(0,Math.floor((Math.min(...hrValues)-10)/10)*10);
  const hrMax=Math.ceil((Math.max(...hrValues)+10)/10)*10;

  const x=i=>pad.left+(readings.length===1?chartW/2:i/(readings.length-1)*chartW);
  const yBP=v=>pad.top+chartH-(v-bpMin)/(Math.max(1,bpMax-bpMin))*chartH;
  const yHR=v=>pad.top+chartH-(v-hrMin)/(Math.max(1,hrMax-hrMin))*chartH;

  ctx.font="10px Arial";ctx.textAlign="right";ctx.textBaseline="middle";
  for(let i=0;i<=4;i++){
    const y=pad.top+chartH*i/4;
    ctx.strokeStyle=grid;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(width-pad.right,y);ctx.stroke();
    const bpValue=Math.round(bpMax-(bpMax-bpMin)*i/4);
    const hrValue=Math.round(hrMax-(hrMax-hrMin)*i/4);
    ctx.fillStyle=text;ctx.fillText(String(bpValue),pad.left-8,y);
    ctx.textAlign="left";ctx.fillText(String(hrValue),width-pad.right+8,y);ctx.textAlign="right";
  }

  ctx.save();ctx.translate(12,pad.top+chartH/2);ctx.rotate(-Math.PI/2);
  ctx.textAlign="center";ctx.fillStyle=text;ctx.font="10px Arial";ctx.fillText("BP (mmHg)",0,0);ctx.restore();
  ctx.save();ctx.translate(width-7,pad.top+chartH/2);ctx.rotate(Math.PI/2);
  ctx.textAlign="center";ctx.fillStyle=text;ctx.font="10px Arial";ctx.fillText("Heart rate (BPM)",0,0);ctx.restore();

  function drawLine(key,color,scale) {
    ctx.beginPath();ctx.lineWidth=2.5;ctx.strokeStyle=color;ctx.lineJoin="round";ctx.lineCap="round";
    readings.forEach((r,i)=>{
      const px=x(i),py=scale(Number(r[key]));
      if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
    });
    ctx.stroke();
    readings.forEach((r,i)=>{
      const px=x(i),py=scale(Number(r[key]));
      ctx.beginPath();ctx.arc(px,py,3.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
      ctx.strokeStyle=styles.getPropertyValue("--surface").trim()||"#fff";ctx.lineWidth=1.5;ctx.stroke();
    });
  }
  drawLine("systolic","#0d9488",yBP);
  drawLine("diastolic","#3976cf",yBP);
  drawLine("heartRate","#e45c69",yHR);

  ctx.fillStyle=text;ctx.font="9px Arial";ctx.textAlign="center";
  const step=Math.max(1,Math.ceil(readings.length/6));
  readings.forEach((r,i)=>{
    if(i%step===0||i===readings.length-1){
      const date=new Date(r.date+"T00:00:00");
      ctx.fillText(date.toLocaleDateString("en-IN",{day:"numeric",month:"short"}),x(i),height-20);
    }
  });
}

window.addEventListener("resize",()=>{if(currentPage==="dashboard")drawHealthCharts();});

/* BACKUP AND RESTORE */

async function exportBackup() {
  const button=$("#exportBackup");button.disabled=true;button.textContent="Preparing backup...";
  try{
    const files=await dbAll(),attachments=[];
    for(const f of files){
      const blob=f.blob||f.file;if(!blob)continue;
      attachments.push({id:f.id,recordId:f.recordId||"",name:f.name||"attachment",type:f.type||blob.type,size:f.size||blob.size,createdAt:f.createdAt||new Date().toISOString(),data:await blobToDataURL(blob)});
    }
    const backup={app:"HealthMemory",version:3,exportedAt:new Date().toISOString(),state,attachments};
    const blob=new Blob([JSON.stringify(backup)],{type:"application/json"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download="HealthMemory_Backup_"+today()+".json";
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
    toast("Backup downloaded with attachments.");
  }catch(err){console.error(err);toast("Backup failed: "+err.message);}
  finally{button.disabled=false;button.textContent="↓ Export Backup";}
}
$("#exportBackup").addEventListener("click",exportBackup);

async function importBackupFile(file) {
  if(!file)return;
  try{
    const backup=JSON.parse(await file.text()),saved=backup.state||backup;
    if(!saved||typeof saved!=="object"||!Array.isArray(saved.records))throw new Error("Invalid HealthMemory backup.");
    const imported={
      records:Array.isArray(saved.records)?saved.records:[],
      medicines:Array.isArray(saved.medicines)?saved.medicines:[],
      appointments:Array.isArray(saved.appointments)?saved.appointments:[],
      family:Array.isArray(saved.family)?saved.family:[],
      profile:saved.profile&&typeof saved.profile==="object"?saved.profile:{},
      emergency:saved.emergency&&typeof saved.emergency==="object"?saved.emergency:{},
      healthReadings:Array.isArray(saved.healthReadings)?saved.healthReadings:[]
    };
    const prepared=[];
    for(const f of Array.isArray(backup.attachments)?backup.attachments:[]){
      if(!f.id||typeof f.data!=="string"||!f.data.startsWith("data:"))throw new Error("Invalid attachment in backup.");
      prepared.push({id:f.id,recordId:f.recordId||"",name:f.name||"attachment",type:f.type||"application/octet-stream",size:f.size||0,createdAt:f.createdAt||new Date().toISOString(),blob:dataURLToBlob(f.data)});
    }
    if(!confirm("Import backup? Current HealthMemory data will be replaced."))return;
    const oldState=state,oldFiles=await dbAll();
    try{
      await dbClear();
      for(const f of prepared)await dbPut(f);
      state=imported;
      if(!saveState())throw new Error("Could not save imported application data.");
    }catch(err){
      await dbClear();for(const f of oldFiles)await dbPut(f);
      state=oldState;localStorage.setItem(STORE,JSON.stringify(oldState));throw err;
    }
    loadProfile();renderAll();await refreshStorage();toast("Backup imported successfully.");
  }catch(err){console.error(err);toast("Backup import failed: "+err.message);}
}
$("#importBackup").addEventListener("change",async e=>{const f=e.target.files[0];if(f)await importBackupFile(f);e.target.value="";});

/* STORAGE */

async function refreshStorage() {
  try{
    const files=await dbAll(),total=files.reduce((sum,f)=>sum+(f.size||f.blob?.size||0),0);
    $("#storageInfo").innerHTML=`
      <div class="storage-stat"><small>Medical records</small><strong>${state.records.length}</strong></div>
      <div class="storage-stat"><small>Stored attachments</small><strong>${files.length}</strong></div>
      <div class="storage-stat"><small>Attachment size</small><strong>${fileSize(total)}</strong></div>`;
    if(navigator.storage?.estimate){
      const estimate=await navigator.storage.estimate();
      if(estimate.quota){
        $("#storageInfo").insertAdjacentHTML("beforeend",`
          <div class="storage-stat"><small>Browser storage used</small><strong>${fileSize(estimate.usage||0)}</strong></div>
          <div class="storage-stat"><small>Estimated available</small><strong>${fileSize(Math.max(0,estimate.quota-(estimate.usage||0)))}</strong></div>`);
      }
    }
  }catch(err){console.error(err);$("#storageInfo").innerHTML=`<div class="storage-stat"><small>Database</small><strong>Unavailable</strong></div>`;}
}
$("#refreshStorage").addEventListener("click",refreshStorage);
$("#deleteAll").addEventListener("click",async()=>{
  if(!confirm("Delete ALL HealthMemory data and attachments? This cannot be undone."))return;
  if(!confirm("Final confirmation: permanently delete everything?"))return;
  try{
    await dbClear();localStorage.removeItem(STORE);
    state={records:[],medicines:[],appointments:[],family:[],profile:{},emergency:{},healthReadings:[]};
    loadProfile();
    if(!saveState())throw new Error("Could not save empty state.");
    await refreshStorage();toast("All data deleted.");
  }catch(err){console.error(err);toast("Could not delete data: "+err.message);}
});

/* THEME */

function applyTheme(dark,save=true) {
  document.body.classList.toggle("dark",dark);
  $("#themeToggle").textContent=dark?"☀":"☾";
  if(save){try{localStorage.setItem(THEME_STORE,dark?"dark":"light");}catch(e){console.warn(e);}}
  if(typeof drawHealthCharts==="function")drawHealthCharts();
}
$("#themeToggle").addEventListener("click",()=>applyTheme(!document.body.classList.contains("dark")));
function loadTheme() {
  try{applyTheme(localStorage.getItem(THEME_STORE)==="dark",false);}
  catch(e){applyTheme(false,false);}
}

/* INITIALIZATION */

async function init() {
  loadState();
  loadProfile();
  loadTheme();
  renderAll();
  renderScanFiles();
  resetHealthReadingForm();
  if(!$("#recordDate").value)$("#recordDate").value=today();
  if(!$("#medicineStart").value)$("#medicineStart").value=today();
  try{await openDB();console.log("HealthMemory database ready.");}
  catch(err){console.error(err);toast("Database error: "+err.message);}
}
init();
window.addEventListener("pagehide",stopCamera);
window.addEventListener("beforeunload",stopCamera);
