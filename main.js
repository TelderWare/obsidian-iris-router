var B=Object.defineProperty;var Q=Object.getOwnPropertyDescriptor;var X=Object.getOwnPropertyNames;var Y=Object.prototype.hasOwnProperty;var G=(u,e)=>{for(var t in e)B(u,t,{get:e[t],enumerable:!0})},J=(u,e,t,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of X(e))!Y.call(u,i)&&i!==t&&B(u,i,{get:()=>e[i],enumerable:!(r=Q(e,i))||r.enumerable});return u};var V=u=>J(B({},"__esModule",{value:!0}),u);var de={};G(de,{default:()=>L});module.exports=V(de);var v=require("obsidian");var q=require("obsidian"),W="https://api.anthropic.com/v1/messages",E="https://api.anthropic.com/v1/messages/batches",T="2023-06-01",N=3e4,I=12e4,Z=5*6e4,ee="obsidian-iris-router";function te(){let u=new Error().stack;if(!u)return null;let e=/plugins[\/\\]([^\/\\"'?)]+)/g,t=new Set,r;for(;(r=e.exec(u))!==null;){let i=r[1];if(!(i===ee||t.has(i)))return t.add(i),i}return null}function _(){return{queued:[],pending:[]}}var $=2,re=1e3,ie=64,se=32768,ne=2,O=8,ae=6e4,oe=64,ce=new Set(["model","max_tokens","system","messages","temperature","tools","tool_choice","top_p","top_k","stop_sequences"]);function H(u){let e=u,t={};for(let r of Object.keys(e))ce.has(r)&&(t[r]=e[r]);if("stream"in e&&e.stream&&console.warn("Iris Relay: 'stream' is not supported and was stripped from the request."),typeof t.model!="string"||!t.model)throw new Error("Iris Relay: missing or invalid 'model' field.");if(typeof t.max_tokens!="number"||t.max_tokens<1)throw new Error("Iris Relay: missing or invalid 'max_tokens' field.");if(t.max_tokens=Math.min(t.max_tokens,se),!Array.isArray(t.messages)||t.messages.length===0)throw new Error("Iris Relay: missing or empty 'messages' field.");return t}function j(u){return[...u.slice(0,-1),{...u[u.length-1],cache_control:{type:"ephemeral"}}]}function F(u){let e={...u};return e.system!=null&&(typeof e.system=="string"?e.system=[{type:"text",text:e.system,cache_control:{type:"ephemeral"}}]:Array.isArray(e.system)&&e.system.length>0&&(e.system=j(e.system))),Array.isArray(e.tools)&&e.tools.length>0&&(e.tools=j(e.tools)),e}var le=5,C=200,P=class{constructor(e,t){this.queue=[];this.activeByKey=new Map;this.activeTotal=0;this.changePending=!1;this.drainScheduled=!1;this.rateLimitUntil=new Map;this.rateLimitsRaw=new Map;this.responseCache=new Map;this.stats={totalRequests:0,errors:0};this.nextEntryId=1;this.activeRecords=new Map;this.callerStats=new Map;this.history=[];this.batchState=_();this.batchHandlers=new Map;this.batchBuffered=new Map;this.batchPollTimers=new Map;this.shutdownFlag=!1;this.settings=e,t&&(this.batchState=t.initial,this.persistBatch=t.save)}updateSettings(e){this.settings=e}getRateLimits(){let e=[];for(let[t,r]of this.rateLimitsRaw){let i=this.settings.trivialApiKey&&t===this.settings.trivialApiKey?"trivial":"main",s=Math.max(1,Math.min(O,r.requestsLimit));e.push({...r,role:i,concurrency:s})}return e}getStats(){return{...this.stats}}shutdown(){this.shutdownFlag=!0;for(let e of this.queue.splice(0))this.cleanupAbortListener(e),e.reject(new Error("Iris Relay: plugin unloading."));this.responseCache.clear();for(let e of this.batchPollTimers.values())clearTimeout(e);this.batchPollTimers.clear(),this.batchHandlers.clear(),this.batchBuffered.clear()}async request(e,t){if(t!=null&&t.batch)throw new Error("Iris Relay: batch requests must use enqueueBatch() / flushBatch(), not request().");let r=t==null?void 0:t.signal;if(r!=null&&r.aborted)throw new Error("Iris Relay: request aborted.");if(!this.settings.anthropicApiKey)throw new Error("Iris Relay: no API key configured.");if(this.queue.length>=ie)throw new Error("Iris Relay: queue full, try again later.");this.stats.totalRequests++;let i=H(e),s=typeof(t==null?void 0:t.priority)=="number"?Math.max(0,Math.min(10,t.priority)):le,c=t!=null&&t.trivial&&this.settings.trivialApiKey?this.settings.trivialApiKey:this.settings.anthropicApiKey,n=JSON.stringify(i),o=c+"\0"+n,g=this.responseCache.get(o);if(g&&Date.now()<g.expiresAt)return g.response;let w=(t==null?void 0:t.callerId)||te()||"?";return this.bumpCaller(w,"requests",1),new Promise((x,m)=>{let p={id:this.nextEntryId++,body:i,bodyKey:n,apiKey:c,cacheKey:o,priority:s,callerId:w,enqueuedAt:Date.now(),signal:r,resolve:x,reject:m};if(r){let S=()=>{let y=this.queue.indexOf(p);y!==-1&&(this.queue.splice(y,1),m(new Error("Iris Relay: request aborted.")))};p.abortHandler=S,r.addEventListener("abort",S,{once:!0})}let f=this.queue.findIndex(S=>S.priority>s);f===-1&&(f=this.queue.length),this.queue.splice(f,0,p),this.notifyChange(),this.scheduleDrain()})}scheduleDrain(){this.drainScheduled||(this.drainScheduled=!0,setTimeout(()=>{this.drainScheduled=!1,this.drain()},0))}cleanupAbortListener(e){e.signal&&e.abortHandler&&(e.signal.removeEventListener("abort",e.abortHandler),e.abortHandler=void 0)}maxConcurrencyFor(e){let t=this.rateLimitsRaw.get(e);return t?Math.max(1,Math.min(O,t.requestsLimit)):ne}getActive(e){return this.activeByKey.get(e)||0}adjustActive(e,t){var r;this.activeByKey.set(e,this.getActive(e)+t),this.activeTotal+=t,(r=this.activeListener)==null||r.call(this,this.activeTotal)}setActiveListener(e){this.activeListener=e}setChangeListener(e){this.changeListener=e}notifyChange(){this.changePending||(this.changePending=!0,queueMicrotask(()=>{var e;this.changePending=!1,(e=this.changeListener)==null||e.call(this)}))}getActiveCount(){return this.activeTotal}drain(){var i;let e=Date.now(),t=1/0,r=0;for(;r<this.queue.length;){let s=this.queue[r];if((i=s.signal)!=null&&i.aborted){this.queue.splice(r,1);continue}let{apiKey:c}=s,n=this.rateLimitUntil.get(c)||0;if(e<n){t=Math.min(t,n),r++;continue}if(this.getActive(c)>=this.maxConcurrencyFor(c)){r++;continue}if(this.shouldThrottle(c)){t=Math.min(t,e+2e3),r++;continue}this.queue.splice(r,1),this.cleanupAbortListener(s),this.adjustActive(c,1);let o={id:s.id,callerId:s.callerId,model:String(s.body.model||"?"),role:this.settings.trivialApiKey&&c===this.settings.trivialApiKey?"trivial":"main",priority:s.priority,startedAt:Date.now(),cancelled:!1};this.activeRecords.set(s.id,o),this.notifyChange(),this.execute(s,o).finally(()=>{this.activeRecords.delete(s.id),this.adjustActive(c,-1),this.drain()})}t<1/0&&setTimeout(()=>this.drain(),t-Date.now())}shouldThrottle(e){let t=this.rateLimitsRaw.get(e);if(!t)return!1;let r=Date.now();return r>=t.tokensReset&&r>=t.requestsReset?!1:t.tokensRemaining<t.tokensLimit*.1||t.requestsRemaining<t.requestsLimit*.1}updateRateLimits(e,t){let r=g=>(t==null?void 0:t[g])||"",i=g=>{if(!g)return 0;let w=new Date(g);return isNaN(w.getTime())?0:w.getTime()},s=parseInt(r("anthropic-ratelimit-requests-limit"),10),c=parseInt(r("anthropic-ratelimit-tokens-limit"),10);if(isNaN(s)||isNaN(c))return;let n=parseInt(r("anthropic-ratelimit-requests-remaining"),10),o=parseInt(r("anthropic-ratelimit-tokens-remaining"),10);this.rateLimitsRaw.set(e,{requestsLimit:s,requestsRemaining:isNaN(n)?s:n,requestsReset:i(r("anthropic-ratelimit-requests-reset")),tokensLimit:c,tokensRemaining:isNaN(o)?c:o,tokensReset:i(r("anthropic-ratelimit-tokens-reset"))})}cacheResponse(e,t){let r=Date.now();for(let[i,s]of this.responseCache)r>=s.expiresAt&&this.responseCache.delete(i);if(this.responseCache.size>=oe){let i=this.responseCache.keys().next().value;i!==void 0&&this.responseCache.delete(i)}this.responseCache.set(e,{response:t,expiresAt:r+ae})}async execute(e,t){try{await this.executeInner(e,t)}catch(r){}}applyOverloadBackoff(e,t,r){let i=parseInt((t==null?void 0:t["retry-after"])||"",10),s=(isNaN(i)?10:i)*1e3;this.rateLimitUntil.set(e,Date.now()+s);let c=r===429?"rate limited":"overloaded";return new Error(`Iris Relay: ${c} (${r}), backing off ${s/1e3}s`)}async executeInner(e,t){var g,w,x;let r=null,i=JSON.stringify(F(e.body)),{apiKey:s,cacheKey:c,signal:n}=e;for(let m=0;m<=$;m++){if(t.cancelled){let y=new Error("Iris Relay: request cancelled.");throw e.reject(y),this.recordHistory(t,"cancelled",void 0,y.message),y}if(n!=null&&n.aborted){let y=new Error("Iris Relay: request aborted.");throw e.reject(y),this.recordHistory(t,"cancelled",void 0,y.message),y}if(m>0){this.bumpCaller(t.callerId,"retries",1);let y=re*Math.pow(2,m-1);await new Promise(b=>setTimeout(b,y))}let p=Date.now(),f=this.rateLimitUntil.get(s)||0;p<f&&await new Promise(y=>setTimeout(y,f-p));let S;try{let y=[(0,q.requestUrl)({url:W,method:"POST",headers:{"Content-Type":"application/json","x-api-key":s,"anthropic-version":T,"anthropic-beta":"prompt-caching-2024-07-31"},body:i,throw:!1}),new Promise((d,l)=>{S=setTimeout(()=>l(new Error(`Iris Relay: request timed out after ${this.settings.requestTimeoutMs/1e3}s`)),this.settings.requestTimeoutMs)})],b=await Promise.race(y);if(t.cancelled){let d=new Error("Iris Relay: request cancelled.");throw e.reject(d),this.recordHistory(t,"cancelled",void 0,d.message),d}if(this.updateRateLimits(s,b.headers),b.status===429||b.status===529){r=this.applyOverloadBackoff(s,b.headers,b.status);continue}if(b.status>=500){r=new Error(`Iris Relay: server error ${b.status}`);continue}if(b.status>=400){let d=(x=(w=(g=b.json)==null?void 0:g.error)==null?void 0:w.message)!=null?x:`API ${b.status}`,l=new Error(`Iris Relay: ${d}`);throw this.stats.errors++,this.bumpCaller(t.callerId,"errors",1),e.reject(l),this.recordHistory(t,"error",void 0,l.message),l}return this.cacheResponse(c,b.json),e.resolve(b.json),this.recordHistory(t,"ok",b.json),b.json}catch(y){if(r=y instanceof Error?y:new Error(String(y)),m<$&&r.message.includes("timed out"))continue;if(m>=$)break}finally{S!==void 0&&clearTimeout(S)}}this.stats.errors++,this.bumpCaller(t.callerId,"errors",1);let o=r||new Error("Iris Relay: all retries exhausted");throw e.reject(o),this.recordHistory(t,"error",void 0,o.message),o}getCallerStats(e){let t=this.callerStats.get(e);return t||(t={requests:0,errors:0,retries:0,cancelled:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0},this.callerStats.set(e,t)),t}bumpCaller(e,t,r){let i=this.getCallerStats(e);i[t]+=r}recordHistory(e,t,r,i,s="sync"){let c=(r==null?void 0:r.usage)||{},n=Number(c.input_tokens)||0,o=Number(c.output_tokens)||0,g=Number(c.cache_read_input_tokens)||0,w=Number(c.cache_creation_input_tokens)||0,x={id:e.id,callerId:e.callerId,model:e.model,role:e.role,priority:e.priority,mode:s,startedAt:e.startedAt,endedAt:Date.now(),status:t,inputTokens:n,outputTokens:o,cacheReadTokens:g,cacheCreationTokens:w,error:i,customId:e.customId};this.history.push(x),this.history.length>C&&this.history.splice(0,this.history.length-C);let m=this.getCallerStats(e.callerId);m.inputTokens+=n,m.outputTokens+=o,m.cacheReadTokens+=g,m.cacheCreationTokens+=w,t==="cancelled"&&(m.cancelled+=1),this.notifyChange()}cancelQueued(e){let t=this.queue.findIndex(s=>s.id===e);if(t===-1)return!1;let[r]=this.queue.splice(t,1);this.cleanupAbortListener(r);let i=new Error("Iris Relay: request cancelled.");return r.reject(i),this.bumpCaller(r.callerId,"cancelled",1),this.history.push({id:r.id,callerId:r.callerId,model:String(r.body.model||"?"),role:this.settings.trivialApiKey&&r.apiKey===this.settings.trivialApiKey?"trivial":"main",priority:r.priority,mode:"sync",startedAt:r.enqueuedAt,endedAt:Date.now(),status:"cancelled",inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0,error:"cancelled before dispatch"}),this.history.length>C&&this.history.splice(0,this.history.length-C),this.notifyChange(),!0}cancelActive(e){let t=this.activeRecords.get(e);return t?(t.cancelled=!0,this.notifyChange(),!0):!1}cancelBatchQueued(e,t){let r=this.batchState.queued.length;return this.batchState.queued=this.batchState.queued.filter(i=>!(i.callerId===e&&i.customId===t)),this.batchState.queued.length===r?!1:(this.saveBatchState(),this.notifyChange(),!0)}async cancelBatchPending(e){let t=this.batchState.pending.find(i=>i.batchId===e);if(!t)return!1;let r=this.resolveKey(t.role);if(!r)return!1;try{await(0,q.requestUrl)({url:`${E}/${e}/cancel`,method:"POST",headers:{"x-api-key":r,"anthropic-version":T},throw:!1})}catch(i){console.warn("Iris Relay: batch cancel request failed",i)}return!0}resolveKey(e){return e==="trivial"&&this.settings.trivialApiKey?this.settings.trivialApiKey:this.settings.anthropicApiKey}async saveBatchState(){if(this.persistBatch)try{await this.persistBatch(this.batchState)}catch(e){console.error("Iris Relay: failed to persist batch state",e)}}enqueueBatch(e,t){if(!t||!t.customId||!t.callerId)throw new Error("Iris Relay: enqueueBatch requires customId and callerId.");let r=H(e);this.batchState.queued.push({customId:t.customId,callerId:t.callerId,trivial:!!t.trivial,body:r}),this.bumpCaller(t.callerId,"requests",1),this.saveBatchState(),this.notifyChange()}async flushBatch(e){var g,w,x,m;let t=e!=null&&e.trivial?"trivial":"main",r=this.resolveKey(t);if(!r)throw new Error("Iris Relay: no API key configured.");let i=!!(e!=null&&e.trivial),s=this.batchState.queued.filter(p=>p.trivial===i);if(s.length===0)return null;let c=s.map(p=>({custom_id:p.customId,params:F(p.body)})),n;try{n=await(0,q.requestUrl)({url:E,method:"POST",headers:{"Content-Type":"application/json","x-api-key":r,"anthropic-version":T,"anthropic-beta":"prompt-caching-2024-07-31"},body:JSON.stringify({requests:c}),throw:!1})}catch(p){throw new Error(`Iris Relay: batch submit failed: ${p instanceof Error?p.message:String(p)}`)}if(this.updateRateLimits(r,n.headers),n.status>=400){let p=(x=(w=(g=n.json)==null?void 0:g.error)==null?void 0:w.message)!=null?x:`API ${n.status}`;throw new Error(`Iris Relay: batch submit failed: ${p}`)}let o=(m=n.json)==null?void 0:m.id;if(typeof o!="string")throw new Error("Iris Relay: batch submit returned no id.");return this.batchState.queued=this.batchState.queued.filter(p=>p.trivial!==i),this.batchState.pending.push({batchId:o,role:t,submittedAt:Date.now(),entries:s.map(p=>({customId:p.customId,callerId:p.callerId}))}),await this.saveBatchState(),this.notifyChange(),this.schedulePoll(o,N),o}onBatchResult(e,t){this.batchHandlers.set(e,t);let r=this.batchBuffered.get(e);if(r){this.batchBuffered.delete(e);for(let{customId:i,result:s}of r)try{t(i,s)}catch(c){console.error("Iris Relay: batch handler threw",c)}}return()=>{this.batchHandlers.get(e)===t&&this.batchHandlers.delete(e)}}getLiveSnapshot(){let e=this.settings.trivialApiKey,t=r=>e&&r===e?"trivial":"main";return{active:Array.from(this.activeRecords.values()).map(r=>({id:r.id,callerId:r.callerId,model:r.model,role:r.role,priority:r.priority,startedAt:r.startedAt,cancelled:r.cancelled})),queued:this.queue.map(r=>({id:r.id,model:String(r.body.model||"?"),role:t(r.apiKey),priority:r.priority,callerId:r.callerId})),batchQueued:this.batchState.queued.map(r=>({model:String(r.body.model||"?"),role:r.trivial?"trivial":"main",callerId:r.callerId,customId:r.customId})),batchPending:this.batchState.pending.map(r=>({batchId:r.batchId,entries:r.entries.length,submittedAt:r.submittedAt,role:r.role,items:r.entries.map(i=>({customId:i.customId,callerId:i.callerId}))})),history:this.history.slice().reverse(),callerStats:Array.from(this.callerStats.entries()).map(([r,i])=>({callerId:r,...i})).sort((r,i)=>i.requests-r.requests),stats:{...this.stats}}}getBatchState(){return{queued:this.batchState.queued.length,pending:this.batchState.pending.map(e=>({batchId:e.batchId,entries:e.entries.length,submittedAt:e.submittedAt,role:e.role}))}}resumePending(){this.batchState.queued.length>0&&console.log(`Iris Relay: ${this.batchState.queued.length} batch entries queued (awaiting flush).`);for(let e of this.batchState.pending)this.schedulePoll(e.batchId,0)}schedulePoll(e,t){if(this.shutdownFlag)return;let r=this.batchPollTimers.get(e);r&&clearTimeout(r);let i=setTimeout(()=>{this.batchPollTimers.delete(e),this.pollBatch(e)},t);this.batchPollTimers.set(e,i)}async pollBatch(e){var w,x,m,p;if(this.shutdownFlag)return;let t=this.batchState.pending.find(f=>f.batchId===e);if(!t)return;let r=this.resolveKey(t.role);if(!r){console.warn(`Iris Relay: cannot poll batch ${e}, ${t.role} key missing.`),this.schedulePoll(e,I);return}let i;try{i=await(0,q.requestUrl)({url:`${E}/${e}`,method:"GET",headers:{"x-api-key":r,"anthropic-version":T},throw:!1})}catch(f){console.warn(`Iris Relay: batch ${e} status fetch failed`,f),this.schedulePoll(e,I);return}if(i.status>=400){console.warn(`Iris Relay: batch ${e} status ${i.status}`),this.schedulePoll(e,I);return}if(((w=i.json)==null?void 0:w.processing_status)!=="ended"){let S=Date.now()-t.submittedAt<Z?N:I;this.schedulePoll(e,S);return}let c;try{c=await(0,q.requestUrl)({url:`${E}/${e}/results`,method:"GET",headers:{"x-api-key":r,"anthropic-version":T},throw:!1})}catch(f){console.warn(`Iris Relay: batch ${e} results fetch failed`,f),this.schedulePoll(e,I);return}if(c.status>=400){console.warn(`Iris Relay: batch ${e} results status ${c.status}`),this.schedulePoll(e,I);return}let o=(c.text||"").split(`
`).filter(f=>f.trim().length>0),g=new Map(t.entries.map(f=>[f.customId,f.callerId]));for(let f of o){let S;try{S=JSON.parse(f)}catch(A){continue}let y=S.custom_id,b=g.get(y);if(!b)continue;let d=S.result,l,a="ok",h,k;(d==null?void 0:d.type)==="succeeded"?(l={ok:!0,response:d.message},h=d.message):(d==null?void 0:d.type)==="errored"?(k=((m=(x=d.error)==null?void 0:x.error)==null?void 0:m.message)||((p=d.error)==null?void 0:p.message)||"errored",l={ok:!1,error:k},a="error",this.bumpCaller(b,"errors",1)):(d==null?void 0:d.type)==="canceled"?(k="canceled",l={ok:!1,error:k},a="cancelled"):(d==null?void 0:d.type)==="expired"?(k="expired",l={ok:!1,error:k},a="error",this.bumpCaller(b,"errors",1)):(k="unknown result type",l={ok:!1,error:k},a="error"),this.recordHistory({id:this.nextEntryId++,callerId:b,model:String((h==null?void 0:h.model)||"?"),role:t.role,priority:0,startedAt:t.submittedAt,customId:y},a,h,k,"batch"),this.dispatchBatchResult(b,y,l)}this.batchState.pending=this.batchState.pending.filter(f=>f.batchId!==e),await this.saveBatchState(),this.notifyChange()}dispatchBatchResult(e,t,r){let i=this.batchHandlers.get(e);if(i){try{i(t,r)}catch(c){console.error("Iris Relay: batch handler threw",c)}return}let s=this.batchBuffered.get(e);s||(s=[],this.batchBuffered.set(e,s)),s.push({customId:t,result:r})}};function z(u){if(!u)return"";try{let{safeStorage:e}=require("electron");if(e.isEncryptionAvailable())return"enc:"+e.encryptString(u).toString("base64")}catch(e){}return u}function U(u){if(!u)return"";if(u.startsWith("enc:"))try{let{safeStorage:e}=require("electron");return e.decryptString(Buffer.from(u.slice(4),"base64"))}catch(e){return new v.Notice("Iris Relay: unable to decrypt API key. Please re-enter it in settings."),""}return u}var ue={anthropicApiKey:"",trivialApiKey:"",requestTimeoutSec:60},L=class extends v.Plugin{constructor(){super(...arguments);this.batchState=_()}async onload(){await this.loadSettings(),this.relay=new P(this.relaySettings(),{initial:this.batchState,save:async i=>{this.batchState=i,await this.persistAll()}}),this.relay.resumePending(),this.app.irisRelay=this.relay;let t=document.createElement("style");t.textContent=`
      .iris-status { display: none; align-items: center; cursor: pointer; color: var(--interactive-accent); }
      .iris-status.is-active { display: inline-flex; animation: iris-pulse 1.2s ease-in-out infinite; }
      .iris-status svg { width: 16px; height: 16px; }
      @keyframes iris-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

      .iris-modal .modal-content { padding-top: 4px; }
      .iris-modal-status {
        font-size: 12px;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
        margin-bottom: 14px;
      }
      .iris-modal-status.is-active { color: var(--interactive-accent); font-weight: 600; }

      .iris-section { margin-bottom: 16px; }
      .iris-section-title {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-muted);
        font-weight: 600;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .iris-count {
        background: var(--background-modifier-border);
        color: var(--text-normal);
        padding: 0 6px;
        border-radius: 8px;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0;
      }
      .iris-count.is-active { background: var(--interactive-accent); color: var(--text-on-accent); }
      .iris-section-empty {
        font-size: 12px;
        color: var(--text-faint);
        font-style: italic;
        padding: 3px 2px;
      }

      .iris-row {
        display: grid;
        grid-template-columns: 52px minmax(0,1fr) auto 24px;
        gap: 10px;
        align-items: center;
        padding: 4px 6px;
        font-size: 12px;
        border-radius: 3px;
      }
      .iris-row:hover { background: var(--background-modifier-hover); }
      .iris-row + .iris-row { border-top: 1px solid var(--background-modifier-border); }
      .iris-row.status-cancelled { opacity: 0.6; }

      .iris-row-role {
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        padding: 1px 0;
        border-radius: 3px;
        text-align: center;
      }
      .iris-row-role.role-main { background: rgba(124,156,255,0.15); color: #7c9cff; }
      .iris-row-role.role-trivial { background: rgba(212,164,74,0.15); color: #d4a44a; }
      .iris-row-role.status-ok { background: rgba(74,182,88,0.15); color: #4ab658; }
      .iris-row-role.status-error { background: rgba(220,80,80,0.15); color: var(--text-error); }
      .iris-row-role.status-cancelled { background: var(--background-modifier-hover); color: var(--text-muted); }

      .iris-row-caller {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .iris-row-caller b { font-weight: 500; color: var(--text-normal); }
      .iris-row-model {
        font-family: var(--font-monospace);
        font-size: 10px;
        color: var(--text-muted);
        margin-left: 6px;
      }
      .iris-row-meta {
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
        font-size: 11px;
        white-space: nowrap;
      }
      .iris-row-meta.is-error { color: var(--text-error); }
      .iris-row-cancel {
        width: 20px; height: 20px; padding: 0;
        background: transparent; border: none;
        color: var(--text-faint); cursor: pointer;
        border-radius: 3px; font-size: 11px; line-height: 1;
      }
      .iris-row-cancel:hover { color: var(--text-error); background: var(--background-modifier-hover); }

      .iris-limit-row {
        display: grid;
        grid-template-columns: 52px 1fr 1fr auto;
        gap: 12px;
        padding: 4px 6px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        align-items: center;
      }
      .iris-limit-row + .iris-limit-row { border-top: 1px solid var(--background-modifier-border); }
      .iris-limit-label {
        display: flex;
        justify-content: space-between;
        color: var(--text-muted);
        font-size: 10px;
        margin-bottom: 2px;
      }
      .iris-limit-label b { color: var(--text-normal); font-weight: 500; }
      .iris-limit-bar {
        height: 4px;
        background: var(--background-modifier-border);
        border-radius: 2px;
        overflow: hidden;
      }
      .iris-limit-bar > span {
        display: block; height: 100%;
        background: var(--interactive-accent);
        transition: width 300ms ease-out;
      }
      .iris-limit-bar.low > span { background: #d4a44a; }
      .iris-limit-bar.crit > span { background: var(--text-error); }

      .iris-batch-controls {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        font-size: 12px;
        color: var(--text-muted);
        padding: 4px 6px;
      }
      .iris-batch-btn {
        padding: 3px 10px;
        font-size: 11px;
        background: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 4px;
        color: var(--text-normal);
        cursor: pointer;
      }
      .iris-batch-btn:hover:not(:disabled) { border-color: var(--interactive-accent); color: var(--text-accent); }
      .iris-batch-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      .iris-caller-row {
        display: grid;
        grid-template-columns: minmax(0,1fr) 70px 70px 130px;
        gap: 10px;
        padding: 3px 6px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        align-items: baseline;
      }
      .iris-caller-row + .iris-caller-row { border-top: 1px solid var(--background-modifier-border); }
      .iris-caller-row .iris-row-caller { font-size: 12px; }

      .iris-footer {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid var(--background-modifier-border);
        font-size: 11px;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
      }
      .iris-footer b { color: var(--text-normal); font-weight: 600; }
    `,document.head.appendChild(t),this.register(()=>t.remove());let r=this.addStatusBarItem();r.addClass("iris-status"),(0,v.setIcon)(r,"brain-circuit"),r.addEventListener("click",()=>{new M(this.app,this.relay).open()}),this.relay.setActiveListener(i=>{r.toggleClass("is-active",i>0),r.setAttr("aria-label",i>0?`Iris: ${i} request${i===1?"":"s"} in flight`:"Iris: idle")}),this.addSettingTab(new K(this.app,this))}onunload(){this.relay.shutdown(),delete this.app.irisRelay}relaySettings(){return{anthropicApiKey:this.settings.anthropicApiKey,trivialApiKey:this.settings.trivialApiKey,requestTimeoutMs:this.settings.requestTimeoutSec*1e3}}async loadSettings(){let t=await this.loadData()||{};t.batchState&&Array.isArray(t.batchState.queued)&&Array.isArray(t.batchState.pending)&&(this.batchState=t.batchState);let{batchState:r,...i}=t,s=Object.assign({},ue,i);s.anthropicApiKey=U(s.anthropicApiKey),s.trivialApiKey=U(s.trivialApiKey||""),this.settings=s}async persistAll(){let t={...this.settings};t.anthropicApiKey=z(t.anthropicApiKey),t.trivialApiKey=z(t.trivialApiKey),t.batchState=this.batchState,await this.saveData(t)}async saveSettings(){await this.persistAll(),this.relay.updateSettings(this.relaySettings())}},K=class extends v.PluginSettingTab{constructor(e,t){super(e,t),this.plugin=t}display(){let{containerEl:e}=this;e.empty();let t=this.plugin.settings,r=()=>this.plugin.saveSettings();e.createEl("h3",{text:"Iris AI Router"}),e.createEl("p",{text:"Centralised AI API router for iris plugins. Other iris plugins will automatically route requests through this plugin when enabled.",cls:"setting-item-description"}),new v.Setting(e).setName("Anthropic API key").setDesc("Shared API key used by all iris plugins routed through this relay.").addText(n=>{n.inputEl.type="password",n.setPlaceholder("sk-ant-...").setValue(t.anthropicApiKey).onChange(async o=>{t.anthropicApiKey=o.trim(),await r()})}),new v.Setting(e).setName("Trivial API key").setDesc("Optional separate API key for trivial calls (e.g. nickname generation). Falls back to the main key when empty.").addText(n=>{n.inputEl.type="password",n.setPlaceholder("sk-ant-...").setValue(t.trivialApiKey).onChange(async o=>{t.trivialApiKey=o.trim(),await r()})}),new v.Setting(e).setName("Request timeout").setDesc("Seconds before a single API request times out.").addDropdown(n=>n.addOption("30","30s").addOption("60","60s").addOption("90","90s").addOption("120","120s").setValue(String(t.requestTimeoutSec)).onChange(async o=>{t.requestTimeoutSec=parseInt(o,10),await r()}));let i=this.plugin.relay.getRateLimits();if(i.length>0){e.createEl("h4",{text:"API rate limits"});for(let n of i){let o=n.role==="main"?"Main key":"Trivial key",g=n.requestsLimit>0?Math.round(n.requestsRemaining/n.requestsLimit*100):100,w=n.tokensLimit>0?Math.round(n.tokensRemaining/n.tokensLimit*100):100,x=`Requests: ${n.requestsRemaining.toLocaleString()} / ${n.requestsLimit.toLocaleString()} remaining (${g}%) \xB7 Tokens: ${n.tokensRemaining.toLocaleString()} / ${n.tokensLimit.toLocaleString()} remaining (${w}%) \xB7 Concurrency: ${n.concurrency}`;new v.Setting(e).setName(o).setDesc(x)}}let s=this.plugin.relay.getBatchState();if(e.createEl("h4",{text:"Batch mode"}),e.createEl("p",{text:"Iris plugins can enqueue requests for the cheaper async batches API. Results are delivered within 24h; Obsidian must be running for polling to advance.",cls:"setting-item-description"}),new v.Setting(e).setName("Queued").setDesc(`${s.queued} request${s.queued===1?"":"s"} waiting to be flushed`).addButton(n=>n.setButtonText("Flush main").onClick(async()=>{try{let o=await this.plugin.relay.flushBatch();new v.Notice(o?`Iris: submitted batch ${o}`:"Iris: queue empty")}catch(o){new v.Notice(`Iris: ${o instanceof Error?o.message:String(o)}`)}this.display()})).addButton(n=>n.setButtonText("Flush trivial").onClick(async()=>{try{let o=await this.plugin.relay.flushBatch({trivial:!0});new v.Notice(o?`Iris: submitted batch ${o}`:"Iris: queue empty")}catch(o){new v.Notice(`Iris: ${o instanceof Error?o.message:String(o)}`)}this.display()})),s.pending.length>0)for(let n of s.pending){let o=Math.round((Date.now()-n.submittedAt)/6e4);new v.Setting(e).setName(`Pending ${n.batchId}`).setDesc(`${n.entries} request${n.entries===1?"":"s"} \xB7 ${n.role} key \xB7 submitted ${o} min ago`)}let c=this.plugin.relay.getStats();c.totalRequests>0&&(e.createEl("h4",{text:"Session stats"}),new v.Setting(e).setName("Totals").setDesc(`${c.totalRequests} requests \xB7 ${c.errors} errors`))}},M=class extends v.Modal{constructor(e,t){super(e),this.relay=t}onOpen(){this.titleEl.setText("Iris Router"),this.modalEl.addClass("iris-modal"),this.modalEl.style.width="min(640px, 95vw)",this.render(),this.relay.setChangeListener(()=>this.render()),this.ageTicker=window.setInterval(()=>this.tickAges(),1e3)}onClose(){this.relay.setChangeListener(void 0),this.ageTicker!==void 0&&window.clearInterval(this.ageTicker),this.contentEl.empty()}tickAges(){let e=Date.now();this.contentEl.querySelectorAll("[data-started-at]").forEach(t=>{let r=parseInt(t.dataset.startedAt,10);isNaN(r)||(t.textContent=this.fmtAge(e-r))})}fmtAge(e){let t=Math.max(0,Math.round(e/1e3));if(t<60)return`${t}s`;let r=Math.floor(t/60);return r<60?`${r}m ${t%60}s`:`${Math.floor(r/60)}h ${r%60}m`}fmtTime(e){return new Date(e).toLocaleTimeString()}fmtNum(e){return e.toLocaleString()}fmtTokens(e){return e<1e3?String(e):e<1e6?`${(e/1e3).toFixed(e<1e4?1:0)}k`:`${(e/1e6).toFixed(1)}M`}section(e,t,r,i=!1){let s=e.createDiv({cls:"iris-section"}),c=s.createDiv({cls:"iris-section-title"});if(c.createSpan({text:t}),r!==void 0){let n=c.createSpan({cls:"iris-count",text:String(r)});i&&n.addClass("is-active")}return s}rolePill(e,t,r){e.createSpan({cls:`iris-row-role role-${t} status-${t}`,text:r!=null?r:t})}callerCell(e,t,r){let i=e.createDiv({cls:"iris-row-caller"});i.createEl("b",{text:t}),r&&i.createSpan({cls:"iris-row-model",text:r})}render(){let e=this.relay.getLiveSnapshot(),t=this.relay.getRateLimits(),r=this.relay.getBatchState(),i=Date.now(),s=document.createElement("div"),c=s.createDiv({cls:"iris-modal-status"}),n=e.active.length,o=e.queued.length;if(n>0||o>0){c.addClass("is-active");let l=[];n>0&&l.push(`${n} in flight`),o>0&&l.push(`${o} queued`),c.textContent=l.join(" \xB7 ")}else c.textContent="idle";if(t.length>0){let l=this.section(s,"Rate limits");for(let a of t)this.renderLimit(l,a)}let g=this.section(s,"Active",n,n>0);if(n===0)g.createDiv({text:"no requests in flight",cls:"iris-section-empty"});else for(let l of e.active){let a=g.createDiv({cls:`iris-row${l.cancelled?" status-cancelled":""}`});this.rolePill(a,l.role),this.callerCell(a,l.callerId,l.model);let h=a.createSpan({cls:"iris-row-meta"});h.dataset.startedAt=String(l.startedAt),h.textContent=this.fmtAge(i-l.startedAt),l.cancelled?a.createSpan():a.createEl("button",{cls:"iris-row-cancel",text:"\u2715",attr:{title:"Cancel"}}).addEventListener("click",()=>this.relay.cancelActive(l.id))}if(o>0){let l=this.section(s,"Queued",o);for(let a of e.queued){let h=l.createDiv({cls:"iris-row"});this.rolePill(h,a.role),this.callerCell(h,a.callerId,a.model),h.createSpan({cls:"iris-row-meta",text:`p${a.priority}`}),h.createEl("button",{cls:"iris-row-cancel",text:"\u2715",attr:{title:"Cancel"}}).addEventListener("click",()=>this.relay.cancelQueued(a.id))}}if(r.queued>0||e.batchPending.length>0||e.history.some(l=>l.mode==="batch")){let l=this.section(s,"Batch"),a=l.createDiv({cls:"iris-batch-controls"});a.createSpan({text:`${r.queued} queued`});let h=a.createEl("button",{cls:"iris-batch-btn",text:"Flush main"});h.disabled=r.queued===0,h.addEventListener("click",()=>this.flush(!1));let k=a.createEl("button",{cls:"iris-batch-btn",text:"Flush trivial"});k.disabled=r.queued===0,k.addEventListener("click",()=>this.flush(!0));for(let A of e.batchPending){let R=l.createDiv({cls:"iris-row"});this.rolePill(R,A.role),this.callerCell(R,A.batchId,`${A.entries} item${A.entries===1?"":"s"}`);let D=R.createSpan({cls:"iris-row-meta"});D.dataset.startedAt=String(A.submittedAt),D.textContent=this.fmtAge(i-A.submittedAt),R.createSpan()}}let x=e.callerStats.filter(l=>l.requests>0).slice(0,5);if(x.length>0){let l=this.section(s,"Callers");for(let a of x){let h=l.createDiv({cls:"iris-caller-row"});this.callerCell(h,a.callerId),h.createSpan({cls:"iris-row-meta",text:`${a.requests} req`}),h.createSpan({cls:`iris-row-meta${a.errors>0?" is-error":""}`,text:a.errors>0?`${a.errors} err`:"\u2014"}),h.createSpan({cls:"iris-row-meta",text:`${this.fmtTokens(a.inputTokens)} in \xB7 ${this.fmtTokens(a.outputTokens)} out`})}}let m=e.history.slice(0,15);if(m.length>0){let l=this.section(s,"Recent");for(let a of m){let h=l.createDiv({cls:`iris-row status-${a.status}`}),k=a.status==="ok"?"ok":a.status==="error"?"err":"canc";this.rolePill(h,a.status,k),this.callerCell(h,a.callerId,a.model);let A=Math.max(0,a.endedAt-a.startedAt),R=a.status==="error"&&a.error?a.error.length>36?a.error.slice(0,36)+"\u2026":a.error:`${(A/1e3).toFixed(1)}s`;h.createSpan({cls:`iris-row-meta${a.status==="error"?" is-error":""}`,text:R}),h.createSpan({cls:"iris-row-meta",text:this.fmtTime(a.endedAt)})}}let p=e.stats,f=e.callerStats.reduce((l,a)=>l+a.inputTokens,0),S=e.callerStats.reduce((l,a)=>l+a.outputTokens,0),y=e.callerStats.reduce((l,a)=>l+a.cacheReadTokens,0),b=s.createDiv({cls:"iris-footer"}),d=(l,a)=>{let h=b.createSpan();h.createSpan({text:`${l} `}),h.createEl("b",{text:typeof a=="number"?this.fmtNum(a):a})};d("Total",p.totalRequests),d("Errors",p.errors),d("Input",this.fmtTokens(f)),d("Output",this.fmtTokens(S)),y>0&&d("Cache read",this.fmtTokens(y)),this.contentEl.replaceChildren(s)}renderLimit(e,t){let r=e.createDiv({cls:"iris-limit-row"});this.rolePill(r,t.role);let i=(s,c,n,o)=>{let g=r.createDiv(),w=g.createDiv({cls:"iris-limit-label"});w.createSpan({text:s}),w.createEl("b",{text:n>0?`${o(c)} / ${o(n)}`:"\u2014"});let x=g.createDiv({cls:"iris-limit-bar"}),m=n>0?Math.max(0,Math.min(1,c/n)):1;m<.1?x.addClass("crit"):m<.3&&x.addClass("low"),x.createSpan().style.width=`${Math.max(2,m*100)}%`};i("Requests",t.requestsRemaining,t.requestsLimit,s=>this.fmtNum(s)),i("Tokens",t.tokensRemaining,t.tokensLimit,s=>this.fmtTokens(s)),r.createSpan({cls:"iris-row-meta",text:`conc ${t.concurrency}`})}async flush(e){try{let t=await this.relay.flushBatch(e?{trivial:!0}:void 0);new v.Notice(t?`Iris: submitted batch ${t}`:"Iris: queue empty")}catch(t){new v.Notice(`Iris: ${t instanceof Error?t.message:String(t)}`)}this.render()}};
