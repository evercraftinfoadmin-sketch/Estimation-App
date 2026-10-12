"use strict";

/* Address validation & correction (Google Places).

   Uses the current Places API (New) "Autocomplete Data API"
   (google.maps.places.AutocompleteSuggestion + Place.fetchFields). The legacy
   google.maps.places.Autocomplete widget is not available to Google Cloud projects
   created after March 2025, and this approach keeps the app's own input fields.

   Address data stored on estimates and CRM projects:
   {address, addressStatus, addressStreetNumber, addressRoute, addressUnit, addressCity,
    addressState, addressPostalCode, addressCountry, addressLatitude, addressLongitude,
    addressPlaceId, addressLastVerifiedAt}

   Rules:
   - "verified" only comes from a selected Google Places result with a street number and street.
   - Typing in a verified field removes the verification until a suggestion is selected again.
   - Nothing is invented: missing ZIP / unit / number stay empty. A typed unit (Apt 4, Suite B, #12)
     is kept when Google's result has none.
   - Without Google (no key, network, quota) the field works as a plain text field. */

const ADDRESS_STATUSES = ["verified","unverified","needs_review"];
const PLACE_FIELDS = ["formattedAddress","addressComponents","location","id"];
const ADDRESS_MIN_CHARS = 3;
const ADDRESS_DEBOUNCE_MS = 250;

function emptyAddress(address=""){
  return {
    address:String(address ?? ""),
    addressStatus:"unverified",
    addressStreetNumber:"",
    addressRoute:"",
    addressUnit:"",
    addressCity:"",
    addressState:"",
    addressPostalCode:"",
    addressCountry:"",
    addressLatitude:null,
    addressLongitude:null,
    addressPlaceId:"",
    addressLastVerifiedAt:null
  };
}

function validCoordinate(v, limit){
  const n=Number(v);
  return v!==null && v!=="" && Number.isFinite(n) && Math.abs(n)<=limit ? n : null;
}

// Reads the address fields of any record. Legacy records with only `address` are supported;
// their text is kept as it is and they are simply "unverified".
function normalizeAddressFields(rec={}){
  const a=emptyAddress(rec.address);
  for(const k of ["addressStreetNumber","addressRoute","addressUnit","addressCity","addressState","addressPostalCode","addressCountry","addressPlaceId"]){
    a[k]=String(rec[k] ?? "");
  }
  a.addressStatus=ADDRESS_STATUSES.includes(rec.addressStatus) ? rec.addressStatus : "unverified";
  a.addressLatitude=validCoordinate(rec.addressLatitude,90);
  a.addressLongitude=validCoordinate(rec.addressLongitude,180);
  if(a.addressLatitude===null || a.addressLongitude===null){ a.addressLatitude=null; a.addressLongitude=null; }
  a.addressLastVerifiedAt=rec.addressLastVerifiedAt ? String(rec.addressLastVerifiedAt) : null;
  // "Verified" must come from a Google result.
  if(a.addressStatus==="verified" && !a.addressPlaceId) a.addressStatus="unverified";
  if(!a.address.trim()) a.addressStatus="unverified";
  return a;
}

function hasCoordinates(a){
  return a && a.addressLatitude!==null && a.addressLongitude!==null &&
    Number.isFinite(a.addressLatitude) && Number.isFinite(a.addressLongitude);
}

function googleMapsUrl(a){
  if(!hasCoordinates(a)) return "";
  return "https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(`${a.addressLatitude},${a.addressLongitude}`);
}

function openAddressMap(a){
  const url=googleMapsUrl(a);
  if(url) window.open(url,"_blank","noopener,noreferrer");
}

// Problem with an address, for the review filters: missing | needs_review | unverified | incomplete | null
function addressIssue(rec){
  const a=normalizeAddressFields(rec);
  if(!a.address.trim()) return "missing";
  if(a.addressStatus==="needs_review") return "needs_review";
  if(a.addressStatus==="unverified") return "unverified";
  if(!a.addressStreetNumber || !a.addressRoute || !a.addressCity || !a.addressState || !a.addressPostalCode) return "incomplete";
  return null;
}

const ADDRESS_ISSUE_LABELS = {
  missing:"No address",
  unverified:"Unverified",
  needs_review:"Needs review",
  incomplete:"Incomplete",
  verified:"Verified"
};

function addressBadgeHtml(rec){
  const issue=addressIssue(rec) || "verified";
  const icon=issue==="verified" ? "✓" : issue==="missing" ? "" : "⚠";
  return `<span class="addr-badge addr-${issue}" title="Address: ${ADDRESS_ISSUE_LABELS[issue]}">${icon} ${ADDRESS_ISSUE_LABELS[issue]}</span>`;
}

function matchesAddressFilter(rec, filter){
  if(!filter || filter==="all") return true;
  const issue=addressIssue(rec);
  return filter==="verified" ? issue===null : issue===filter;
}

function addressFilterOptions(records, selected){
  const counts={all:records.length,missing:0,unverified:0,needs_review:0,incomplete:0,verified:0};
  records.forEach(r=>{ counts[addressIssue(r) || "verified"]++; });
  const opts=[["all","All addresses"],["missing","Missing address"],["unverified","Unverified"],["needs_review","Needs review"],["incomplete","Incomplete"],["verified","Verified"]];
  return opts.map(([v,l])=>`<option value="${v}" ${v===selected?"selected":""}>${l} (${counts[v]})</option>`).join("");
}

/* Sync rule between a linked estimate and CRM project:
   the address that was saved last is copied to the other record, except that
   - an empty address never replaces an existing one, and
   - a verified address is never replaced by an unverified / needs-review one.
   Returns the fields to copy, {blocked:true}, or null when nothing changes. */
function addressSyncUpdate(source, target){
  const s=normalizeAddressFields(source), t=normalizeAddressFields(target);
  if(!s.address.trim()) return null;
  const same=ADDRESS_FIELD_KEYS.every(k=>k==="addressLastVerifiedAt" || s[k]===t[k]);
  if(same) return null;
  if(t.addressStatus==="verified" && s.addressStatus!=="verified" && t.address.trim() && t.address.trim()!==s.address.trim()) return {blocked:true};
  return s;
}

const ADDRESS_FIELD_KEYS = Object.keys(emptyAddress());

/* ---------- Units and components ---------- */

const UNIT_PATTERN=/(?:^|[\s,])((?:apt|apartment|unit|suite|ste|bldg|building|fl|floor|rm|room|lot|spc|space)\.?\s*#?\s*[a-z0-9][a-z0-9-]*|#\s*[a-z0-9][a-z0-9-]*)(?=$|[\s,])/i;

function extractUnit(text){
  const m=String(text||"").match(UNIT_PATTERN);
  return m ? m[1].replace(/\s+/g," ").trim() : "";
}

// Puts a unit after the street part of a formatted address: "123 Main St, Apt 4, Los Angeles, ..."
function insertUnit(formatted, unit){
  if(!unit) return formatted;
  const norm=s=>s.toLowerCase().replace(/[^a-z0-9]/g,"");
  if(norm(formatted).includes(norm(unit))) return formatted;
  const parts=formatted.split(", ");
  parts.splice(1,0,unit);
  return parts.join(", ");
}

function parseAddressComponents(components=[]){
  const long={}, short={};
  for(const c of components||[]){
    for(const type of c.types||[]){
      if(!(type in long)){ long[type]=c.longText ?? c.long_name ?? ""; short[type]=c.shortText ?? c.short_name ?? ""; }
    }
  }
  return {
    addressStreetNumber:long.street_number || "",
    addressRoute:long.route || "",
    addressUnit:long.subpremise ? `#${long.subpremise}` : "",
    addressCity:long.locality || long.postal_town || long.sublocality_level_1 || long.sublocality || long.administrative_area_level_3 || "",
    addressState:short.administrative_area_level_1 || long.administrative_area_level_1 || "",
    addressPostalCode:long.postal_code || "",
    addressCountry:short.country || long.country || ""
  };
}

/* ---------- Google loader (one loader for the whole app) ---------- */

let PLACES_PROMISE = null;
let PLACES_UNAVAILABLE = null; // error code once Google rejected the key
const ADDRESS_FIELDS = [];     // all AddressField instances, to update their status

function placesError(code, cause){
  const e=new Error(code);
  e.code=code; e.cause=cause;
  return e;
}

function configuredMapsKey(){
  const fromSettings=(typeof SETTINGS!=="undefined" && SETTINGS.googleMapsApiKey || "").trim();
  const fromConfig=String((window.EVERCRAFT_CONFIG||{}).googleMapsApiKey || "").trim();
  const key=fromSettings || fromConfig;
  return key && key!=="YOUR_RESTRICTED_API_KEY" ? key : "";
}

function addressRegionCodes(){
  const r=(window.EVERCRAFT_CONFIG||{}).addressRegionCodes;
  return Array.isArray(r) && r.length ? r.slice(0,15) : ["us"];
}

function loadPlacesLibrary(){
  if(PLACES_UNAVAILABLE) return Promise.reject(placesError(PLACES_UNAVAILABLE));
  if(PLACES_PROMISE) return PLACES_PROMISE;
  PLACES_PROMISE=(async()=>{
    // Use Google Maps if the page already loaded it; never load it twice.
    if(!(window.google && google.maps && google.maps.importLibrary)){
      const key=configuredMapsKey();
      if(!key) throw placesError("not_configured");
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(placesError("timeout")),15000);
        window.__everCraftMapsReady=()=>{ clearTimeout(timer); resolve(); };
        // Google calls this when the key is invalid, restricted or billing is missing.
        window.gm_authFailure=()=>{ PLACES_UNAVAILABLE="denied"; refreshAddressFields(); };
        const s=document.createElement("script");
        s.id="google-maps-loader";
        s.async=true;
        s.src="https://maps.googleapis.com/maps/api/js?key="+encodeURIComponent(key)+
          "&v=weekly&libraries=places&loading=async&callback=__everCraftMapsReady";
        s.onerror=()=>{ clearTimeout(timer); s.remove(); reject(placesError("network")); };
        document.head.appendChild(s);
      });
    }
    const lib=await google.maps.importLibrary("places");
    if(!lib || !lib.AutocompleteSuggestion) throw placesError("unsupported");
    return lib;
  })();
  PLACES_PROMISE.catch(err=>{
    // A failed download may be retried later; other failures stay until the page reloads.
    if(err.code==="network" || err.code==="timeout" || err.code==="not_configured") PLACES_PROMISE=null;
  });
  return PLACES_PROMISE;
}

// Called after the API key is changed in Settings.
function resetPlacesLoader(){
  if(!(window.google && google.maps && google.maps.importLibrary)){
    PLACES_PROMISE=null;
    PLACES_UNAVAILABLE=null;
  }
  refreshAddressFields();
}

function classifyPlacesError(err){
  if(err && ["not_configured","network","timeout","denied","unsupported"].includes(err.code)) return err.code;
  const msg=String(err && (err.message || err.code) || err || "").toUpperCase();
  if(/QUOTA|RESOURCE_EXHAUSTED|OVER_QUERY_LIMIT|RATE|429/.test(msg)) return "quota";
  if(/API_KEY|REQUEST_DENIED|PERMISSION_DENIED|BILLING|NOT AUTHORIZED|403|REFERER|REFERRER/.test(msg)) return "denied";
  if(/NETWORK|FAILED TO FETCH|OFFLINE|TIMEOUT/.test(msg)) return "network";
  return "error";
}

const PLACES_ERROR_MESSAGES = {
  not_configured:"Address suggestions are off: add a Google Maps API key in Settings. You can still type the address.",
  denied:"Google rejected the address lookup (check the API key, enabled APIs and billing). You can still type the address.",
  quota:"Address lookup limit reached. Try again later, or keep the entered address.",
  network:"Address suggestions are unavailable (network problem). You can still type the address.",
  timeout:"Address suggestions are unavailable (Google did not respond). You can still type the address.",
  unsupported:"This Google Maps version does not support address suggestions. You can still type the address.",
  error:"Address suggestions are unavailable right now. You can still type the address."
};

function refreshAddressFields(){ ADDRESS_FIELDS.forEach(f=>f.render()); }

/* ---------- Address field controller ---------- */

class AddressField{
  constructor(input, options={}){
    this.input=input;
    this.onChange=options.onChange || (()=>{});
    this.data=emptyAddress();
    this.previous=null;     // last verified data, merged if the same place is selected again
    this.pending=null;      // selected result that needs confirmation
    this.items=[];
    this.active=-1;
    this.seq=0;
    this.token=null;
    this.timer=null;
    this.serviceError=null;
    this.busy=false;
    this.build();
    ADDRESS_FIELDS.push(this);
    this.render();
  }

  build(){
    const id=this.input.id;
    const wrap=document.createElement("div");
    wrap.className="addr-wrap";
    this.input.parentNode.insertBefore(wrap,this.input);
    wrap.appendChild(this.input);

    this.list=document.createElement("div");
    this.list.className="addr-suggestions";
    this.list.id=`${id}-suggestions`;
    this.list.setAttribute("role","listbox");
    this.list.hidden=true;
    wrap.appendChild(this.list);

    this.input.setAttribute("role","combobox");
    this.input.setAttribute("aria-autocomplete","list");
    this.input.setAttribute("aria-expanded","false");
    this.input.setAttribute("aria-controls",this.list.id);
    this.input.setAttribute("autocomplete","off");

    this.status=document.createElement("div");
    this.status.className="addr-status";
    this.status.id=`${id}-status`;
    this.status.innerHTML=`
      <div class="addr-message" role="status" aria-live="polite"></div>
      <div class="addr-detail"></div>
      <div class="addr-actions">
        <button type="button" class="btn btn-light btn-sm" data-addr="confirm" hidden>Confirm Address</button>
        <button type="button" class="btn btn-light btn-sm" data-addr="keep" hidden>Keep Entered Address</button>
        <button type="button" class="btn btn-light btn-sm" data-addr="map" hidden>Open in Google Maps</button>
      </div>`;
    wrap.after(this.status);
    this.input.setAttribute("aria-describedby",this.status.id);

    this.input.addEventListener("input",()=>this.onInput());
    this.input.addEventListener("keydown",e=>this.onKeyDown(e));
    this.input.addEventListener("focus",()=>{ if(configuredMapsKey() || (window.google && google.maps)) loadPlacesLibrary().catch(()=>{}); });
    this.input.addEventListener("blur",()=>setTimeout(()=>{ this.close(); this.render(); },150));
    this.list.addEventListener("mousedown",e=>e.preventDefault()); // keep focus in the input
    this.list.addEventListener("click",e=>{
      const opt=e.target.closest("[data-index]");
      if(opt) this.select(Number(opt.dataset.index));
    });
    this.status.addEventListener("click",e=>{
      const btn=e.target.closest("[data-addr]");
      if(!btn) return;
      if(btn.dataset.addr==="confirm") this.confirmPending();
      else if(btn.dataset.addr==="keep") this.keepEntered();
      else if(btn.dataset.addr==="map") openAddressMap(this.pending ? this.pendingAsData() : this.data);
    });
  }

  /* ----- data in / out ----- */

  setData(rec){
    this.failMessage=null;
    this.data=normalizeAddressFields(rec||{});
    this.previous=this.data.addressPlaceId ? {...this.data} : null;
    this.pending=null;
    this.serviceError=null;
    this.token=null;
    this.input.value=this.data.address;
    this.close();
    this.render();
  }

  getData(){
    const typed=this.input.value.trim();
    if(typed!==this.data.address.trim()) this.invalidate(typed); // never keep a stale verification
    return {...this.data,address:typed};
  }

  invalidate(text){
    if(this.data.addressPlaceId) this.previous={...this.data};
    this.data=emptyAddress(text);
  }

  /* ----- typing and suggestions ----- */

  onInput(){
    const typed=this.input.value;
    this.failMessage=null;
    if(this.data.addressStatus!=="unverified" || this.data.addressPlaceId || this.pending){
      if(typed.trim()!==this.data.address.trim() || this.pending){
        this.invalidate(typed.trim());
        this.pending=null;
      }
    }else{
      this.data.address=typed.trim();
    }
    this.render();
    clearTimeout(this.timer);
    if(typed.trim().length<ADDRESS_MIN_CHARS){ this.close(); return; }
    this.timer=setTimeout(()=>this.fetchSuggestions(typed.trim()),ADDRESS_DEBOUNCE_MS);
  }

  async fetchSuggestions(query){
    const seq=++this.seq;
    let lib;
    try{
      lib=await loadPlacesLibrary();
      if(!this.token) this.token=new lib.AutocompleteSessionToken();
      const {suggestions}=await lib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input:query,
        sessionToken:this.token,
        includedRegionCodes:addressRegionCodes()
      });
      if(seq!==this.seq || document.activeElement!==this.input) return;
      this.serviceError=null;
      this.items=(suggestions||[]).filter(s=>s && s.placePrediction).slice(0,6).map(s=>{
        const p=s.placePrediction;
        return {
          prediction:p,
          main:(p.mainText && p.mainText.text) || (p.text && p.text.text) || "",
          secondary:(p.secondaryText && p.secondaryText.text) || ""
        };
      });
      this.active=-1;
      this.renderList();
    }catch(err){
      if(seq!==this.seq) return;
      this.serviceError=classifyPlacesError(err);
      this.close();
      this.render();
    }
  }

  renderList(){
    this.list.innerHTML="";
    if(!this.items.length){
      const empty=document.createElement("div");
      empty.className="addr-empty";
      empty.textContent="No matching addresses found. Check the spelling, or keep the entered address.";
      this.list.appendChild(empty);
    }
    this.items.forEach((it,i)=>{
      const opt=document.createElement("div");
      opt.className="addr-option"+(i===this.active?" active":"");
      opt.id=`${this.list.id}-${i}`;
      opt.setAttribute("role","option");
      opt.setAttribute("aria-selected",String(i===this.active));
      opt.dataset.index=String(i);
      const main=document.createElement("b"); main.textContent=it.main;
      const sec=document.createElement("span"); sec.textContent=it.secondary;
      opt.append(main,sec);
      this.list.appendChild(opt);
    });
    this.list.hidden=false;
    this.input.setAttribute("aria-expanded","true");
    if(this.active>=0) this.input.setAttribute("aria-activedescendant",`${this.list.id}-${this.active}`);
    else this.input.removeAttribute("aria-activedescendant");
  }

  close(){
    this.list.hidden=true;
    this.input.setAttribute("aria-expanded","false");
    this.input.removeAttribute("aria-activedescendant");
  }

  onKeyDown(e){
    if(this.list.hidden || !this.items.length){
      if(e.key==="Escape") this.close();
      return;
    }
    if(e.key==="ArrowDown"){ e.preventDefault(); this.active=(this.active+1)%this.items.length; this.renderList(); }
    else if(e.key==="ArrowUp"){ e.preventDefault(); this.active=(this.active-1+this.items.length)%this.items.length; this.renderList(); }
    else if(e.key==="Enter" && this.active>=0){ e.preventDefault(); this.select(this.active); }
    else if(e.key==="Escape"){ this.close(); }
  }

  /* ----- selecting a suggestion ----- */

  async select(index){
    const item=this.items[index];
    if(!item) return;
    const typedText=this.input.value;
    const typedUnit=extractUnit(typedText);
    this.close();
    this.busy=true;
    this.render();
    try{
      const place=item.prediction.toPlace();
      await place.fetchFields({fields:PLACE_FIELDS});
      this.token=null; // the session ends with the details request
      this.busy=false;
      if(!place.id){ this.fail("The selected result could not be identified. Select another suggestion."); return; }
      const lat=place.location && typeof place.location.lat==="function" ? place.location.lat() : null;
      const lng=place.location && typeof place.location.lng==="function" ? place.location.lng() : null;
      if(validCoordinate(lat,90)===null || validCoordinate(lng,180)===null){
        this.fail("The selected result has no map location. Select another suggestion or keep the entered address.");
        return;
      }
      const parts=parseAddressComponents(place.addressComponents);
      // Keep a unit the user typed when Google's result has none.
      const unit=parts.addressUnit || typedUnit;
      let candidate={
        ...emptyAddress(),
        ...parts,
        addressUnit:unit,
        address:insertUnit(place.formattedAddress || item.main, parts.addressUnit ? "" : typedUnit),
        addressLatitude:lat,
        addressLongitude:lng,
        addressPlaceId:place.id
      };
      // Same place selected again: fill gaps from the earlier verified data, never blank them out.
      if(this.previous && this.previous.addressPlaceId===candidate.addressPlaceId){
        for(const k of ["addressStreetNumber","addressRoute","addressUnit","addressCity","addressState","addressPostalCode","addressCountry"]){
          if(!candidate[k] && this.previous[k]) candidate[k]=this.previous[k];
        }
      }
      if(candidate.addressStreetNumber && candidate.addressRoute){
        this.apply(candidate,"verified");
      }else{
        this.pending=candidate;
        this.render();
      }
    }catch(err){
      this.busy=false;
      this.serviceError=classifyPlacesError(err);
      this.render();
    }
  }

  fail(message){
    this.pending=null;
    this.failMessage=message; // shown until the user types or picks another result
    this.render();
  }

  pendingAsData(){ return this.pending; }

  apply(candidate, status){
    this.failMessage=null;
    this.data={...candidate,addressStatus:status,addressLastVerifiedAt:nowISO()};
    this.previous={...this.data};
    this.pending=null;
    this.serviceError=null;
    this.input.value=this.data.address;
    this.render();
    this.onChange(this.data);
    this.input.dispatchEvent(new CustomEvent("evercraft:address-verified",{bubbles:true,detail:{...this.data}}));
  }

  // A result without a full street address, accepted by the user: kept, flagged for review.
  confirmPending(){
    if(this.pending) this.apply(this.pending,"needs_review");
  }

  // The user's own text, without Google data: flagged for review.
  keepEntered(){
    const text=this.input.value.trim();
    if(!text) return;
    this.data={...emptyAddress(text),addressStatus:"needs_review"};
    this.pending=null;
    this.render();
    this.onChange(this.data);
  }

  /* ----- status area ----- */

  render(){
    const msg=this.status.querySelector(".addr-message");
    const detail=this.status.querySelector(".addr-detail");
    const show=(name,on)=>{ this.status.querySelector(`[data-addr="${name}"]`).hidden=!on; };
    const d=this.data;
    const text=this.input.value.trim();
    const error=this.serviceError || PLACES_UNAVAILABLE;
    let state="unverified", message="", extra="", confirm=false, keep=false, map=false;

    if(this.busy){
      message="Checking address…"; state="loading";
    }else if(this.failMessage){
      message=this.failMessage; state="warning"; keep=!!text;
    }else if(this.pending){
      state="warning";
      message="This may not be a complete street address. Review it before confirming.";
      extra="Google result: "+this.pending.address;
      confirm=true; keep=!!text; map=hasCoordinates(this.pending);
    }else if(d.addressStatus==="verified" && text){
      state="verified";
      message="✓ Address verified with Google Places.";
      const missing=[!d.addressPostalCode && "ZIP code",!d.addressCity && "city"].filter(Boolean);
      if(missing.length) extra=`Google did not provide the ${missing.join(" and ")}.`;
      map=hasCoordinates(d);
    }else if(d.addressStatus==="needs_review" && text){
      state="warning";
      message="⚠ This address could not be fully verified. Please review it.";
      extra=d.addressPlaceId ? "" : "Entered manually, not checked with Google.";
      map=hasCoordinates(d);
    }else if(!text){
      message=error ? PLACES_ERROR_MESSAGES[error] || PLACES_ERROR_MESSAGES.error : "Start typing and select a suggested address.";
      state=error ? "unavailable" : "hint";
    }else{
      state="warning";
      message=error ? PLACES_ERROR_MESSAGES[error] || PLACES_ERROR_MESSAGES.error : "Select a suggested address to verify it.";
      keep=true;
    }
    msg.textContent=message;
    detail.textContent=extra;
    detail.hidden=!extra;
    this.status.dataset.state=state;
    show("confirm",confirm); show("keep",keep); show("map",map);
  }
}
