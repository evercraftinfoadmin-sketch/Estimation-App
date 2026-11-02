"use strict";

/* Clients → Properties (addresses) → Projects.
   A client is the person (primary contact); a property is a physical address of that client; a
   CRM project is one job at one property. One client can have many properties, one property many
   projects. Each project keeps client_id and propertyId, and still keeps its own copy of the
   client details and the address, so estimates, PDFs, maps, the calendar and photos work as before.

   Records (each list syncs to its Base44 table, see CLOUD_LISTS in cloud.js):
     clients    Client    {id, clientName, clientEmail, clientPhone, notes, archived}
     properties Property  {id, clientId, address fields (address.js), notes, archived}

   The same client = the same email or the same phone (digits). The same name alone is only
   shown as a possible duplicate, never merged. Properties are archived, never deleted. */

const PROPERTY_NONE = "";

/* ---------- records ---------- */

function normalizeClient(c){
  return {
    id:String(c.id),
    clientName:String(c.clientName ?? "").slice(0,200),
    clientEmail:String(c.clientEmail ?? "").trim().slice(0,200),
    clientPhone:String(c.clientPhone ?? "").trim().slice(0,60),
    notes:String(c.notes ?? "").slice(0,4000),
    archived:!!c.archived,
    createdAt:c.createdAt || nowISO(),
    updatedAt:c.updatedAt || c.createdAt || nowISO()
  };
}

function normalizeProperty(r){
  return {
    id:String(r.id),
    clientId:String(r.clientId ?? ""),
    ...normalizeAddressFields(r),
    notes:String(r.notes ?? "").slice(0,4000),
    archived:!!r.archived,
    createdAt:r.createdAt || nowISO(),
    updatedAt:r.updatedAt || r.createdAt || nowISO()
  };
}

const clientList=(key,norm)=>{ const l=readStore(key,[]); return Array.isArray(l) ? l.filter(r=>r && r.id).map(norm) : []; };
function loadClients(){ return clientList(STORAGE_KEYS.clients,normalizeClient); }
function loadProperties(){ return clientList(STORAGE_KEYS.properties,normalizeProperty); }
function getClient(id){ return id ? loadClients().find(c=>c.id===id) || null : null; }
function getProperty(id){ return id ? loadProperties().find(r=>r.id===id) || null : null; }
function clientProperties(clientId, withArchived=false){
  return loadProperties().filter(r=>r.clientId===clientId && (withArchived || !r.archived));
}
function propertyProjects(propertyId){ return loadProjects().filter(p=>p.propertyId===propertyId); }

function saveClientRecord(c){
  const list=loadClients();
  const i=list.findIndex(x=>x.id===c.id);
  if(i>=0) list[i]=c; else list.push(c);
  return writeStore(STORAGE_KEYS.clients,list);
}

function savePropertyRecord(r){
  const list=loadProperties();
  const i=list.findIndex(x=>x.id===r.id);
  if(i>=0) list[i]=r; else list.push(r);
  return writeStore(STORAGE_KEYS.properties,list);
}

/* ---------- matching ---------- */

const normEmail=e=>String(e || "").trim().toLowerCase();
// Digits only; US numbers compared by their last 10 digits (+1 or not).
function normPhone(p){
  const d=String(p || "").replace(/\D+/g,"");
  return d.length>=10 ? d.slice(-10) : d.length>=7 ? d : "";
}
const normName=n=>String(n || "").trim().toLowerCase().replace(/\s+/g," ");

// An existing client with the same email or phone: {client, by:"email"|"phone"} or null.
function findClientMatch({clientEmail, clientPhone}, exceptId=""){
  const e=normEmail(clientEmail), ph=normPhone(clientPhone);
  if(!e && !ph) return null;
  for(const c of loadClients()){
    if(c.id===exceptId || c.archived) continue;
    if(e && normEmail(c.clientEmail)===e) return {client:c, by:"email"};
    if(ph && normPhone(c.clientPhone)===ph) return {client:c, by:"phone"};
  }
  return null;
}

// The same place: Google's place id when both have one, else the address text without
// punctuation, case, "USA" or extra spaces.
function addressKey(a){
  const text=String(a.address || "").toLowerCase().replace(/\b(usa|united states)\b/g,"").replace(/[^a-z0-9#]+/g," ").trim();
  return text;
}
function sameAddress(a, b){
  if(a.addressPlaceId && b.addressPlaceId && a.addressPlaceId===b.addressPlaceId) return true;
  const ka=addressKey(a), kb=addressKey(b);
  return !!ka && ka===kb;
}

function findClientProperty(clientId, addr, exceptId=""){
  return loadProperties().find(r=>r.clientId===clientId && r.id!==exceptId && sameAddress(r,addr)) || null;
}

/* ---------- creating ---------- */

function createClient(data){
  const c=normalizeClient({...data,id:uid("cli"),createdAt:nowISO(),updatedAt:nowISO()});
  if(!c.clientName.trim() && !c.clientEmail && !c.clientPhone) return {error:"Enter the client's name, email or phone."};
  if(!saveClientRecord(c)) return {error:"Could not save on this device."};
  return c;
}

// Contact details typed for a project fill in or update the client; empty values never erase.
function updateClientContact(clientId, data){
  const c=getClient(clientId);
  if(!c) return null;
  const changes={};
  for(const k of ["clientName","clientEmail","clientPhone"]){
    const v=String(data[k] ?? "").trim();
    if(v && v!==c[k]) changes[k]=v;
  }
  if(!Object.keys(changes).length) return c;
  const next=normalizeClient({...c,...changes,updatedAt:nowISO()});
  saveClientRecord(next);
  return next;
}

// A new property for a client. Refuses a second copy of the same address for that client.
function addProperty(clientId, addr, notes=""){
  if(!getClient(clientId)) return {error:"Choose the client first."};
  const data=normalizeAddressFields(addr);
  if(!data.address.trim()) return {error:"Enter the street address."};
  const dup=findClientProperty(clientId,data);
  if(dup) return {error:`This address is already saved for this client${dup.archived ? " (archived: restore it on the client's page)" : ""}.`, existing:dup};
  const r=normalizeProperty({...data,id:uid("prop"),clientId,notes,createdAt:nowISO(),updatedAt:nowISO()});
  if(!savePropertyRecord(r)) return {error:"Could not save on this device."};
  return r;
}

// Archive or restore an address. Its projects stay as they are (never deleted).
function setPropertyArchived(id, archived){
  const r=getProperty(id);
  if(!r) return {error:"The address was not found."};
  const next=normalizeProperty({...r,archived,updatedAt:nowISO()});
  return savePropertyRecord(next) ? next : {error:"Could not save on this device."};
}

// The client and property a project is saved with. clientId: the client chosen in the form
// ("" = a new client from the typed details). Returns {client_id, propertyId} or {error}.
function resolveProjectLinks(data, clientId){
  let client=clientId ? getClient(clientId) : null;
  if(clientId && !client) return {error:"The chosen client was not found."};
  if(client) client=updateClientContact(client.id,data);
  else{
    client=createClient({clientName:data.clientName || data.address || "Client",clientEmail:data.clientEmail,clientPhone:data.clientPhone});
    if(client.error) return client;
  }
  const addr=normalizeAddressFields(data);
  if(!addr.address.trim()) return {client_id:client.id, propertyId:PROPERTY_NONE};
  let prop=findClientProperty(client.id,addr);
  if(prop && prop.archived) prop=setPropertyArchived(prop.id,false); // used again: back in the list
  if(!prop){
    prop=addProperty(client.id,addr);
    if(prop.error) return prop;
  }
  return {client_id:client.id, propertyId:prop.id};
}

/* ---------- linking existing projects (report first) ---------- */

// What linking the projects not linked yet would do. Nothing is changed here.
function buildClientReport(){
  const projects=loadProjects();
  const clients=loadClients();
  const unlinked=projects.filter(p=>!p.client_id || !getClient(p.client_id));
  // Group by email / phone (union-find), on top of the clients that already exist.
  const parent=new Map();
  const find=x=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x))); x=parent.get(x); } return x; };
  const union=(a,b)=>{ const ra=find(a), rb=find(b); if(ra!==rb) parent.set(ra,rb); };
  const byKey=new Map();
  const nodes=[...clients.map(c=>({id:"c:"+c.id,email:normEmail(c.clientEmail),phone:normPhone(c.clientPhone),client:c})),
    ...unlinked.map(p=>({id:"p:"+p.id,email:normEmail(p.clientEmail),phone:normPhone(p.clientPhone),project:p}))];
  for(const n of nodes){
    parent.set(n.id,n.id);
    for(const k of [n.email && "e:"+n.email, n.phone && "t:"+n.phone].filter(Boolean)){
      if(byKey.has(k)) union(n.id,byKey.get(k)); else byKey.set(k,n.id);
    }
  }
  const groups=new Map();
  for(const n of nodes){ const r=find(n.id); if(!groups.has(r)) groups.set(r,[]); groups.get(r).push(n); }

  const plan=[];   // {client (existing) | newClient, projects:[{project, property|newProperty|null}]}
  const props=loadProperties();
  for(const members of groups.values()){
    const ps=members.filter(m=>m.project).map(m=>m.project);
    if(!ps.length) continue;
    const existing=members.filter(m=>m.client).map(m=>m.client);
    const g={client:existing[0] || null, conflict:existing.length>1 ? existing : null, newClient:null, projects:[], newProperties:[]};
    if(!g.client){
      const first=[...ps].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
      g.newClient={clientName:first.clientName || first.address || "Client",
        clientEmail:(ps.find(p=>p.clientEmail) || {}).clientEmail || "",clientPhone:(ps.find(p=>p.clientPhone) || {}).clientPhone || ""};
    }
    const cid=g.client ? g.client.id : null;
    for(const p of ps){
      const addr=normalizeAddressFields(p);
      if(!addr.address.trim()){ g.projects.push({project:p, property:null, review:"no address"}); continue; }
      const prop=cid ? props.find(r=>r.clientId===cid && sameAddress(r,addr)) : null;
      if(prop){ g.projects.push({project:p, property:prop}); continue; }
      let np=g.newProperties.find(x=>sameAddress(x,addr));
      if(!np){ np={...addr}; g.newProperties.push(np); }
      g.projects.push({project:p, newProperty:np});
    }
    plan.push(g);
  }
  // Possible duplicates: the same name in different groups; similar addresses of one client.
  const names=new Map();
  for(const g of plan){
    const n=normName(g.client ? g.client.clientName : g.newClient.clientName);
    if(!n) continue;
    if(!names.has(n)) names.set(n,[]);
    names.get(n).push(g);
  }
  for(const c of clients){ const n=normName(c.clientName); if(n && names.has(n) && !names.get(n).some(g=>g.client && g.client.id===c.id)) names.get(n).push({client:c}); }
  const dupNames=[...names.entries()].filter(([,gs])=>gs.length>1).map(([n,gs])=>({name:n,count:gs.length}));
  const dupAddresses=[];
  for(const g of plan){
    const all=[...g.newProperties,...(g.client ? props.filter(r=>r.clientId===g.client.id) : [])];
    for(let i=0;i<all.length;i++) for(let j=i+1;j<all.length;j++){
      const a=all[i], b=all[j];
      const num=x=>(String(x.address).match(/^\s*(\d+)/) || [])[1];
      const zip=x=>(String(x.address).match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/) || [])[1];
      if(num(a) && num(a)===num(b) && zip(a) && zip(a)===zip(b)) dupAddresses.push({client:g.client ? g.client.clientName : g.newClient.clientName,a:a.address,b:b.address});
    }
  }
  return {
    clients:clients.length,
    projects:projects.length,
    linked:projects.length-unlinked.length,
    unlinked:unlinked.length,
    groups:plan,
    newClients:plan.filter(g=>!g.client).length,
    newProperties:plan.reduce((t,g)=>t+g.newProperties.length,0),
    review:plan.flatMap(g=>g.projects.filter(x=>x.review).map(x=>x.project)),
    conflicts:plan.filter(g=>g.conflict),
    dupNames, dupAddresses
  };
}

// Links the projects as the report says. Projects keep their own details and their date of last
// change (the link is bookkeeping, not an edit). Returns {clients, properties, projects}.
function applyClientReport(report){
  const made={clients:0, properties:0, projects:0};
  const links=new Map();
  for(const g of report.groups){
    let client=g.client;
    if(!client){
      client=createClient(g.newClient);
      if(client.error) continue;
      made.clients++;
    }
    const propIds=new Map();
    for(const x of g.projects){
      let pid=PROPERTY_NONE;
      if(x.property) pid=x.property.id;
      else if(x.newProperty){
        if(!propIds.has(x.newProperty)){
          let r=findClientProperty(client.id,x.newProperty);
          if(!r){
            r=addProperty(client.id,x.newProperty);
            if(r.error) continue;
            made.properties++;
          }
          propIds.set(x.newProperty,r.id);
        }
        pid=propIds.get(x.newProperty);
      }
      links.set(x.project.id,{client_id:client.id, propertyId:pid});
    }
  }
  const list=loadProjects();
  for(const p of list){
    const l=links.get(p.id);
    if(!l) continue;
    p.client_id=l.client_id;
    p.propertyId=l.propertyId;
    made.projects++;
  }
  if(made.projects && !saveProjects(list)) throw new Error("the projects could not be saved on this device");
  return made;
}

function clientReportCsv(report){
  const rows=[["Client","Email","Phone","Action","Property","Project","Stage","Note"]];
  for(const g of report.groups){
    const c=g.client || g.newClient;
    for(const x of g.projects){
      const prop=x.property ? x.property.address : x.newProperty ? x.newProperty.address : "";
      rows.push([c.clientName,c.clientEmail,c.clientPhone,g.client ? "link to existing client" : "new client",prop,
        projectLabel(x.project),stageLabel(x.project.stage),x.review ? "needs an address (manual review)" : x.newProperty ? "new property" : "existing property"]);
    }
  }
  for(const d of report.dupNames) rows.push([d.name,"","","possible duplicate","","","",`${d.count} clients with this name (not merged)`]);
  for(const d of report.dupAddresses) rows.push([d.client,"","","possible duplicate address",d.a+" / "+d.b,"","",""]);
  return rows.map(r=>r.map(v=>/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v)).join(",")).join("\r\n");
}

/* ---------- showing ---------- */

// "Painting, Drywall — EST-2026-1001" or the estimate number, or "Project".
function projectLabel(p){
  const est=p.estimateId ? getEstimate(p.estimateId) : null;
  const service=est ? Object.entries(est.categoryTotals || {}).filter(([,v])=>amount(v)>0).map(([k])=>categoryLabel(k,k)).join(", ") : "";
  return service || p.estimateNumber || "Project";
}

function projectStageText(p){
  if(p.canceled) return "Canceled";
  if(p.stage==="prospect") return prospectLabel(p.prospectStatus) || stageLabel(p.stage);
  return stageLabel(p.stage);
}

function clientProjects(clientId){ return loadProjects().filter(p=>p.client_id===clientId); }

let CLIENT_SEARCH = "";
let OPEN_CLIENT_ID = null;
let OPEN_PROPERTY_ID = null;
let ADDRESS_FORM = null; // {clientId, onSaved}
let ADDRESS_SEARCH = null; // AddressField of the Add Address window

function renderClientsPage(){
  const q=CLIENT_SEARCH.trim().toLowerCase();
  const projects=loadProjects();
  const props=loadProperties();
  const list=loadClients().filter(c=>!c.archived)
    .filter(c=>!q || [c.clientName,c.clientEmail,c.clientPhone,...props.filter(r=>r.clientId===c.id).map(r=>r.address)].some(v=>String(v).toLowerCase().includes(q)))
    .sort((a,b)=>a.clientName.localeCompare(b.clientName));
  const unlinked=projects.filter(p=>!p.client_id || !getClient(p.client_id)).length;
  $("clientsNote").innerHTML=unlinked
    ? `${unlinked} CRM project${unlinked===1?" is":"s are"} not linked to a client yet. ${finIsManagerForClients() ? `<button type="button" class="btn-link" data-cl-action="report">Link existing projects…</button>` : "An owner or admin can link them."}`
    : "";
  $("clientsBody").innerHTML=list.map(c=>{
    const ps=props.filter(r=>r.clientId===c.id && !r.archived).length;
    const pj=projects.filter(p=>p.client_id===c.id).length;
    return `<tr data-client="${escapeHtml(c.id)}" class="fin-row-link">
      <td data-label="Client"><b>${escapeHtml(c.clientName || "Unnamed client")}</b></td>
      <td data-label="Contact">${escapeHtml([c.clientPhone,c.clientEmail].filter(Boolean).join(" · ") || "—")}</td>
      <td data-label="Properties" class="num">${ps}</td>
      <td data-label="Projects" class="num">${pj}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="4" class="muted">${q ? "No client matches the search." : "No clients yet."}</td></tr>`;
}

function finIsManagerForClients(){
  if(!(typeof cloudActive==="function" && cloudActive())) return true;
  return ["owner","admin"].includes(CLOUD.role);
}

function projectRowHtml(p){
  return `<li><button type="button" class="btn-link" data-cl-project="${escapeHtml(p.id)}">${escapeHtml(projectLabel(p))}</button>
    <span class="cl-stage">— ${escapeHtml(projectStageText(p))}</span>${p.scheduledDate?` <span class="small">· ${escapeHtml(formatDate(p.scheduledDate))}</span>`:""}</li>`;
}

function openClientProfile(id){
  const c=getClient(id);
  if(!c) return;
  OPEN_CLIENT_ID=id;
  $("clientModalTitle").textContent=c.clientName || "Client";
  $("clName").value=c.clientName;
  $("clEmail").value=c.clientEmail;
  $("clPhone").value=c.clientPhone;
  $("clNotes").value=c.notes;
  renderClientProperties();
  openModal("clientModal");
}

function renderClientProperties(){
  const id=OPEN_CLIENT_ID;
  const all=clientProperties(id,true);
  const projects=clientProjects(id);
  const card=(r,i)=>{
    const ps=projects.filter(p=>p.propertyId===r.id);
    return `<div class="cl-prop ${r.archived?"cl-prop-archived":""}" data-property="${escapeHtml(r.id)}">
      <div class="cl-prop-head">
        <div><div class="small">Property ${i+1}${r.archived?" · archived":""}</div>
          <button type="button" class="btn-link cl-prop-addr" data-cl-action="property">${escapeHtml(r.address)}</button>
          ${r.notes?`<div class="small">${escapeHtml(r.notes)}</div>`:""}</div>
        <div class="btn-row">${r.archived ? `<button type="button" class="btn btn-light btn-sm" data-cl-action="restore">Restore</button>`
          : `<button type="button" class="btn btn-light btn-sm" data-cl-action="new-project">+ Create Project</button>`}</div>
      </div>
      ${ps.length ? `<ul class="cl-projects">${ps.map(projectRowHtml).join("")}</ul>` : `<p class="small muted">No projects at this address yet.</p>`}
    </div>`;
  };
  const active=all.filter(r=>!r.archived), archived=all.filter(r=>r.archived);
  const noAddr=projects.filter(p=>!p.propertyId || !all.some(r=>r.id===p.propertyId));
  $("clProperties").innerHTML=(active.map(card).join("") || `<p class="muted">No addresses yet.</p>`)
    +(noAddr.length ? `<div class="cl-prop cl-prop-review"><div class="small"><b>Projects without a property address</b> (need an address)</div><ul class="cl-projects">${noAddr.map(projectRowHtml).join("")}</ul></div>` : "")
    +(archived.length ? `<details class="cl-archived"><summary>${archived.length} archived address${archived.length===1?"":"es"}</summary>${archived.map((r,i)=>card(r,active.length+i)).join("")}</details>` : "");
}

function saveClientProfile(){
  const c=getClient(OPEN_CLIENT_ID);
  if(!c) return;
  const data={clientName:$("clName").value.trim(),clientEmail:$("clEmail").value.trim(),clientPhone:$("clPhone").value.trim(),notes:$("clNotes").value.trim()};
  if(!data.clientName && !data.clientEmail && !data.clientPhone){ alert("Enter the client's name, email or phone."); return; }
  const other=findClientMatch(data,c.id);
  if(other && !confirm(`${other.client.clientName || "Another client"} already has this ${other.by}. Save anyway?`)) return;
  const next=normalizeClient({...c,...data,updatedAt:nowISO()});
  if(!saveClientRecord(next)) return;
  // The client is the primary contact: open projects take the new details (never emptied).
  const list=loadProjects();
  let n=0;
  for(const p of list){
    if(p.client_id!==c.id || ["completed","followup"].includes(p.stage)) continue;
    for(const k of ["clientName","clientEmail","clientPhone"]) if(data[k] && p[k]!==data[k]){ p[k]=data[k]; n++; }
  }
  if(n) saveProjects(list);
  $("clientModalTitle").textContent=next.clientName || "Client";
  renderClientsPage();
  showToast("Client saved."+(n ? " Open projects use the new contact details." : ""));
}

function openPropertyDetail(id){
  const r=getProperty(id);
  if(!r) return;
  OPEN_PROPERTY_ID=id;
  const c=getClient(r.clientId);
  $("propTitle").textContent=r.address;
  $("propClient").innerHTML=c ? `<button type="button" class="btn-link" data-prop-action="client">${escapeHtml(c.clientName || "Client")}</button> ${escapeHtml([c.clientPhone,c.clientEmail].filter(Boolean).join(" · "))}` : "—";
  $("propAddress").innerHTML=`${escapeHtml(r.address)} ${addressBadgeHtml(r)}${hasCoordinates(r)?` <a href="${escapeHtml(googleMapsUrl(r))}" target="_blank" rel="noopener">Map</a>`:""}`;
  $("propNotes").value=r.notes;
  const ps=propertyProjects(id);
  $("propProjects").innerHTML=ps.length ? `<ul class="cl-projects">${ps.map(projectRowHtml).join("")}</ul>` : `<p class="muted">No projects at this address yet.</p>`;
  $("propArchive").textContent=r.archived ? "Restore address" : "Archive address";
  $("propNewProject").hidden=r.archived;
  openModal("propertyModal");
}

// New CRM project at a property: the client and the address are filled in, nothing to choose.
function createProjectAtProperty(propertyId){
  const r=getProperty(propertyId);
  const c=r && getClient(r.clientId);
  if(!r || !c) return;
  closeModal("propertyModal");
  closeModal("clientModal");
  showPage("crm");
  openProjectModal(null,null,{clientId:c.id, propertyId:r.id});
}

/* ---------- Add Address window ---------- */

function openAddressForm(clientId, onSaved){
  const c=getClient(clientId);
  if(!c){ alert("Choose or save the client first."); return; }
  ADDRESS_FORM={clientId, onSaved:onSaved || null, saving:false};
  $("addrClient").textContent=c.clientName || c.clientPhone || "this client";
  ADDRESS_SEARCH.setData({});
  for(const id of ["addrStreet","addrUnit","addrCity","addrState","addrZip","addrNotes"]) $(id).value="";
  $("addrCountry").value="US";
  $("addrStatus").textContent="";
  openModal("addressModal");
  $("addrSearch").focus();
}

// A Google suggestion picked: fill in the separate fields.
function fillAddressFromSearch(){
  const d=ADDRESS_SEARCH.data;
  if(!d || !d.addressPlaceId) return;
  $("addrStreet").value=[d.addressStreetNumber,d.addressRoute].filter(Boolean).join(" ") || d.address.split(",")[0];
  $("addrUnit").value=d.addressUnit;
  $("addrCity").value=d.addressCity;
  $("addrState").value=d.addressState;
  $("addrZip").value=d.addressPostalCode;
  $("addrCountry").value=d.addressCountry || "US";
}

function readAddressForm(){
  const street=$("addrStreet").value.trim(), unit=$("addrUnit").value.trim(), city=$("addrCity").value.trim(),
    state=$("addrState").value.trim(), zip=$("addrZip").value.trim(), country=$("addrCountry").value.trim() || "US";
  const text=[street+(unit ? (/^(apt|unit|suite|ste|#)/i.test(unit) ? " "+unit : " #"+unit) : ""),city,[state,zip].filter(Boolean).join(" "),country==="US" ? "" : country].filter(Boolean).join(", ");
  const d=ADDRESS_SEARCH.data;
  // Still the Google result (same street / city / zip): keep it verified.
  const fromGoogle=d && d.addressPlaceId && [d.addressStreetNumber,d.addressRoute].filter(Boolean).join(" ")===street && d.addressCity===city && d.addressPostalCode===zip;
  const base=fromGoogle ? {...d} : emptyAddress(text);
  return {...base,address:fromGoogle ? (unit && !d.addressUnit ? insertUnit(d.address,unit) : d.address) : text,
    addressUnit:unit,addressCity:city,addressState:state,addressPostalCode:zip,addressCountry:country,
    addressRoute:fromGoogle ? d.addressRoute : street,addressStreetNumber:fromGoogle ? d.addressStreetNumber : ""};
}

function submitAddressForm(){
  if(!ADDRESS_FORM || ADDRESS_FORM.saving) return;
  if(!$("addrStreet").value.trim() || !$("addrCity").value.trim()){
    $("addrStatus").textContent="Enter the street address and the city.";
    return;
  }
  ADDRESS_FORM.saving=true;
  const res=addProperty(ADDRESS_FORM.clientId,readAddressForm(),$("addrNotes").value.trim());
  ADDRESS_FORM.saving=false;
  if(res.error){ $("addrStatus").textContent=res.error; return; }
  const done=ADDRESS_FORM.onSaved;
  ADDRESS_FORM=null;
  closeModal("addressModal");
  showToast("Address saved.");
  if(done) done(res);
  if(OPEN_CLIENT_ID && $("clientModal").classList.contains("open")) renderClientProperties();
  renderClientsPage();
}

/* ---------- the project window: client → property ---------- */

let PM_CLIENT_ID = "";

function clientOptionsHtml(selected){
  const list=loadClients().filter(c=>!c.archived || c.id===selected).sort((a,b)=>a.clientName.localeCompare(b.clientName));
  return `<option value="">New client (type the details below)</option>`+list.map(c=>`<option value="${escapeHtml(c.id)}" ${c.id===selected?"selected":""}>${escapeHtml(c.clientName || "Unnamed")}${c.clientPhone?` · ${escapeHtml(c.clientPhone)}`:""}</option>`).join("");
}

function propertyOptionsHtml(clientId, selected){
  if(!clientId) return `<option value="">New address (type it below)</option>`;
  const props=clientProperties(clientId);
  return (props.length>1 ? `<option value="">Choose the property…</option>` : props.length ? "" : `<option value="">No address yet</option>`)
    +props.map(r=>`<option value="${escapeHtml(r.id)}" ${r.id===selected?"selected":""}>${escapeHtml(r.address)}</option>`).join("")
    +`<option value="__new">Another address (type it below)</option>`;
}

// Called by openProjectModal. prefill: {clientId, propertyId} when started from a property.
function preparePmClient(p, prefill){
  PM_CLIENT_ID=(prefill && prefill.clientId) || (p.client_id && getClient(p.client_id) ? p.client_id : "");
  const c=getClient(PM_CLIENT_ID);
  $("pmClientPick").innerHTML=clientOptionsHtml(PM_CLIENT_ID);
  if(prefill && c){
    $("pmClientName").value=c.clientName;
    $("pmClientEmail").value=c.clientEmail;
    $("pmClientPhone").value=c.clientPhone;
  }
  let propId=(prefill && prefill.propertyId) || (p.propertyId && getProperty(p.propertyId) ? p.propertyId : "");
  if(!propId && PM_CLIENT_ID){
    const props=clientProperties(PM_CLIENT_ID);
    if(props.length===1 && !p.address) propId=props[0].id; // the only address: chosen
  }
  $("pmPropertyPick").innerHTML=propertyOptionsHtml(PM_CLIENT_ID,propId);
  if(prefill && propId) PROJECT_ADDRESS.setData(getProperty(propId));
  $("pmClientMatch").hidden=true;
}

function handlePmClientPick(){
  PM_CLIENT_ID=$("pmClientPick").value;
  const c=getClient(PM_CLIENT_ID);
  if(c){
    $("pmClientName").value=c.clientName;
    $("pmClientEmail").value=c.clientEmail;
    $("pmClientPhone").value=c.clientPhone;
  }
  const props=PM_CLIENT_ID ? clientProperties(PM_CLIENT_ID) : [];
  const one=props.length===1 ? props[0].id : "";
  $("pmPropertyPick").innerHTML=propertyOptionsHtml(PM_CLIENT_ID,one);
  if(one) PROJECT_ADDRESS.setData(props[0]);
  else if(props.length>1) PROJECT_ADDRESS.setData({});
  $("pmClientMatch").hidden=true;
}

function handlePmPropertyPick(){
  const v=$("pmPropertyPick").value;
  if(v==="__new"){ PROJECT_ADDRESS.setData({}); $("pmAddress").focus(); return; }
  const r=getProperty(v);
  if(r) PROJECT_ADDRESS.setData(r);
}

// Typing the email / phone of a new client: suggest the existing client (never linked silently).
function suggestPmClient(){
  if(PM_CLIENT_ID){ $("pmClientMatch").hidden=true; return; }
  const m=findClientMatch({clientEmail:$("pmClientEmail").value,clientPhone:$("pmClientPhone").value});
  $("pmClientMatch").hidden=!m;
  if(m) $("pmClientMatch").innerHTML=`Existing client: <b>${escapeHtml(m.client.clientName || "Unnamed")}</b> (same ${m.by}). <button type="button" class="btn btn-light btn-sm" data-pm-client="${escapeHtml(m.client.id)}">Use this client</button>`;
}

// "+ Add address" in the project window: the project form stays as it is.
function pmAddAddress(){
  let id=PM_CLIENT_ID;
  if(!id){
    const data={clientName:$("pmClientName").value.trim(),clientEmail:$("pmClientEmail").value.trim(),clientPhone:$("pmClientPhone").value.trim()};
    const m=findClientMatch(data);
    if(m && confirm(`${m.client.clientName || "A client"} already has this ${m.by}. Add the address to that client?`)) id=m.client.id;
    else{
      const c=createClient(data);
      if(c.error){ alert(c.error); $("pmClientName").focus(); return; }
      id=c.id;
    }
    PM_CLIENT_ID=id;
    $("pmClientPick").innerHTML=clientOptionsHtml(id);
    $("pmClientMatch").hidden=true;
  }
  openAddressForm(id,r=>{
    $("pmPropertyPick").innerHTML=propertyOptionsHtml(id,r.id);
    PROJECT_ADDRESS.setData(r);
  });
}

// For saveProjectForm: {client_id, propertyId} or {error} or null (cancelled).
function projectLinksFromForm(data){
  let clientId=PM_CLIENT_ID;
  if(clientId && clientProperties(clientId).length>1 && !$("pmPropertyPick").value && !data.address.trim()){
    return {error:"This client has several addresses: choose the property for this project."};
  }
  if(!clientId){
    const m=findClientMatch(data);
    if(m && confirm(`${m.client.clientName || "A client"} already has this ${m.by}.\n\nOK: link this project to ${m.client.clientName || "that client"}.\nCancel: save as a new client.`)) clientId=m.client.id;
  }
  return resolveProjectLinks(data,clientId);
}

/* ---------- report window (Settings / Clients page) ---------- */

let CLIENT_REPORT = null;

function openClientReport(){
  if(!finIsManagerForClients()){ alert("Only an owner or admin can link existing projects."); return; }
  CLIENT_REPORT=buildClientReport();
  const r=CLIENT_REPORT;
  const li=(t)=>`<li>${t}</li>`;
  $("crBody").innerHTML=`
    <ul class="cr-stats">
      ${li(`<b>${r.clients}</b> clients exist now; <b>${r.projects}</b> CRM projects, <b>${r.linked}</b> already linked`)}
      ${li(`<b>${r.unlinked}</b> projects to link: <b>${r.newClients}</b> new clients and <b>${r.newProperties}</b> new properties would be created`)}
      ${li(`<b>${r.review.length}</b> projects have no address: they are linked to their client and flagged for manual address assignment (no address is invented)`)}
      ${li(`<b>${r.dupNames.length}</b> possible duplicate names and <b>${r.dupAddresses.length}</b> possible duplicate addresses (shown, not merged)`)}
    </ul>
    ${r.review.length ? `<h3>Need an address (manual review)</h3><ul>${r.review.slice(0,50).map(p=>li(escapeHtml((p.clientName || "Unnamed")+" — "+projectLabel(p)+" — "+stageLabel(p.stage)))).join("")}</ul>` : ""}
    ${r.dupNames.length ? `<h3>Same name, different email / phone (not merged)</h3><ul>${r.dupNames.slice(0,50).map(d=>li(`${escapeHtml(d.name)}: ${d.count} clients`)).join("")}</ul>` : ""}
    ${r.dupAddresses.length ? `<h3>Similar addresses of one client</h3><ul>${r.dupAddresses.slice(0,50).map(d=>li(`${escapeHtml(d.client)}: ${escapeHtml(d.a)} / ${escapeHtml(d.b)}`)).join("")}</ul>` : ""}
    ${r.conflicts.length ? `<p class="small">${r.conflicts.length} group(s) match more than one existing client; the first one is used.</p>` : ""}`;
  $("crApply").disabled=!r.unlinked;
  openModal("clientReportModal");
}

async function applyClientReportNow(){
  if(!CLIENT_REPORT || !CLIENT_REPORT.unlinked) return;
  const ok=await confirmAction({title:"Link the existing projects?",message:`${CLIENT_REPORT.unlinked} projects will be linked to clients and addresses.`,
    details:`Creates ${CLIENT_REPORT.newClients} clients and ${CLIENT_REPORT.newProperties} properties. Nothing is deleted; projects keep all their details.`,confirmLabel:"Link projects"});
  if(!ok) return;
  $("crApply").disabled=true;
  try{
    const made=applyClientReport(buildClientReport());
    closeModal("clientReportModal");
    renderClientsPage();
    showToast(`${made.projects} projects linked to their clients and addresses.`);
  }catch(e){
    alert("Linking stopped: "+(e && e.message ? e.message : "unknown error")+". Nothing was deleted.");
    $("crApply").disabled=false;
  }
}

function wireClientEvents(){
  ADDRESS_SEARCH=new AddressField($("addrSearch"),{onChange:fillAddressFromSearch});
  $("clientSearch").addEventListener("input",e=>{ CLIENT_SEARCH=e.target.value; renderClientsPage(); });
  $("btnNewClient").addEventListener("click",()=>{ showPage("crm"); openProjectModal(null); });
  $("page-clients").addEventListener("click",e=>{
    const row=e.target.closest("[data-client]");
    if(e.target.closest("[data-cl-action=report]")){ openClientReport(); return; }
    if(row) openClientProfile(row.dataset.client);
  });
  $("clientModal").addEventListener("click",e=>{
    const pj=e.target.closest("[data-cl-project]");
    if(pj){ closeModal("clientModal"); showPage("crm"); openProjectModal(pj.dataset.clProject); return; }
    const act=e.target.closest("[data-cl-action]");
    if(!act) return;
    const propId=act.closest("[data-property]") && act.closest("[data-property]").dataset.property;
    if(act.dataset.clAction==="add-address") openAddressForm(OPEN_CLIENT_ID);
    else if(act.dataset.clAction==="save") saveClientProfile();
    else if(act.dataset.clAction==="property") openPropertyDetail(propId);
    else if(act.dataset.clAction==="new-project") createProjectAtProperty(propId);
    else if(act.dataset.clAction==="restore"){ setPropertyArchived(propId,false); renderClientProperties(); showToast("Address restored."); }
  });
  $("propertyModal").addEventListener("click",async e=>{
    const pj=e.target.closest("[data-cl-project]");
    if(pj){ closeModal("propertyModal"); closeModal("clientModal"); showPage("crm"); openProjectModal(pj.dataset.clProject); return; }
    const act=e.target.closest("[data-prop-action]");
    if(!act) return;
    const r=getProperty(OPEN_PROPERTY_ID);
    if(!r) return;
    if(act.dataset.propAction==="client"){ closeModal("propertyModal"); openClientProfile(r.clientId); }
    else if(act.dataset.propAction==="new-project") createProjectAtProperty(r.id);
    else if(act.dataset.propAction==="save-notes"){
      savePropertyRecord(normalizeProperty({...r,notes:$("propNotes").value.trim(),updatedAt:nowISO()}));
      showToast("Property notes saved.");
    }else if(act.dataset.propAction==="archive"){
      if(!r.archived){
        const n=propertyProjects(r.id).length;
        const ok=await confirmAction({title:"Archive this address?",message:r.address,
          details:`It is hidden from the address lists.${n ? ` Its ${n} project${n===1?"":"s"} stay exactly as they are (nothing is deleted).` : ""} You can restore it any time.`,confirmLabel:"Archive"});
        if(!ok) return;
      }
      const res=setPropertyArchived(r.id,!r.archived);
      if(res.error){ alert(res.error); return; }
      showToast(res.archived ? "Address archived. Its projects are kept." : "Address restored.");
      openPropertyDetail(r.id);
      if($("clientModal").classList.contains("open")) renderClientProperties();
    }
  });
  $("addressForm").addEventListener("submit",e=>{ e.preventDefault(); submitAddressForm(); });
  $("pmClientPick").addEventListener("change",handlePmClientPick);
  $("pmPropertyPick").addEventListener("change",handlePmPropertyPick);
  $("pmAddAddress").addEventListener("click",pmAddAddress);
  $("pmClientEmail").addEventListener("input",suggestPmClient);
  $("pmClientPhone").addEventListener("input",suggestPmClient);
  $("pmClientMatch").addEventListener("click",e=>{
    const b=e.target.closest("[data-pm-client]");
    if(!b) return;
    $("pmClientPick").value=b.dataset.pmClient;
    handlePmClientPick();
  });
  $("btnClientReport").addEventListener("click",openClientReport);
  $("crApply").addEventListener("click",applyClientReportNow);
  $("crCsv").addEventListener("click",()=>{ if(CLIENT_REPORT) downloadFile(`client-address-report-${localISODate()}.csv`,"﻿"+clientReportCsv(CLIENT_REPORT),"text/csv"); });
}
