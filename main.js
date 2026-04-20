var K=Object.defineProperty;var G=Object.getOwnPropertyDescriptor;var J=Object.getOwnPropertyNames;var V=Object.prototype.hasOwnProperty;var W=(d,e)=>{for(var t in e)K(d,t,{get:e[t],enumerable:!0})},Z=(d,e,t,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of J(e))!V.call(d,i)&&i!==t&&K(d,i,{get:()=>e[i],enumerable:!(r=G(e,i))||r.enumerable});return d};var ee=d=>Z(K({},"__esModule",{value:!0}),d);var me={};W(me,{default:()=>_});module.exports=ee(me);var f=require("obsidian");var C=require("obsidian"),te="https://api.anthropic.com/v1/messages",L="https://api.anthropic.com/v1/messages/batches",P="2023-06-01",j=3e4,T=12e4,re=5*6e4,ie="obsidian-iris-router";function se(){let d=new Error().stack;if(!d)return null;let e=/plugins[\/\\]([^\/\\"'?)]+)/g,t=new Set,r;for(;(r=e.exec(d))!==null;){let i=r[1];if(!(i===ie||t.has(i)))return t.add(i),i}return null}function D(){return{queued:[],pending:[]}}var M=2,ne=1e3,ae=64,oe=32768,ce=2,F=8,le=6e4,ue=64,de=new Set(["model","max_tokens","system","messages","temperature","tools","tool_choice","top_p","top_k","stop_sequences"]);function z(d){let e=d,t={};for(let r of Object.keys(e))de.has(r)&&(t[r]=e[r]);if("stream"in e&&e.stream&&console.warn("Iris Relay: 'stream' is not supported and was stripped from the request."),typeof t.model!="string"||!t.model)throw new Error("Iris Relay: missing or invalid 'model' field.");if(typeof t.max_tokens!="number"||t.max_tokens<1)throw new Error("Iris Relay: missing or invalid 'max_tokens' field.");if(t.max_tokens=Math.min(t.max_tokens,oe),!Array.isArray(t.messages)||t.messages.length===0)throw new Error("Iris Relay: missing or empty 'messages' field.");return t}function U(d){return[...d.slice(0,-1),{...d[d.length-1],cache_control:{type:"ephemeral"}}]}function Q(d){let e={...d};return e.system!=null&&(typeof e.system=="string"?e.system=[{type:"text",text:e.system,cache_control:{type:"ephemeral"}}]:Array.isArray(e.system)&&e.system.length>0&&(e.system=U(e.system))),Array.isArray(e.tools)&&e.tools.length>0&&(e.tools=U(e.tools)),e}var he=5,B=200,$=class{constructor(e,t){this.queue=[];this.activeByKey=new Map;this.activeTotal=0;this.changePending=!1;this.drainScheduled=!1;this.paused=!1;this.rateLimitUntil=new Map;this.rateLimitsRaw=new Map;this.responseCache=new Map;this.stats={totalRequests:0,attempts:0,errors:0};this.nextEntryId=1;this.activeRecords=new Map;this.callerStats=new Map;this.history=[];this.batchState=D();this.batchHandlers=new Map;this.batchBuffered=new Map;this.batchPollTimers=new Map;this.shutdownFlag=!1;this.settings=e,t&&(this.batchState=t.initial,this.persistBatch=t.save)}updateSettings(e){this.settings=e}getRateLimits(){let e=[];for(let[t,r]of this.rateLimitsRaw){let i=this.settings.trivialApiKey&&t===this.settings.trivialApiKey?"trivial":"main",s=Math.max(1,Math.min(F,r.requestsLimit));e.push({...r,role:i,concurrency:s})}return e}getStats(){return{...this.stats}}shutdown(){this.shutdownFlag=!0;for(let e of this.queue.splice(0))this.cleanupAbortListener(e),e.reject(new Error("Iris Relay: plugin unloading."));this.responseCache.clear();for(let e of this.batchPollTimers.values())clearTimeout(e);this.batchPollTimers.clear(),this.batchHandlers.clear(),this.batchBuffered.clear()}async request(e,t){if(t!=null&&t.batch)throw new Error("Iris Relay: batch requests must use enqueueBatch() / flushBatch(), not request().");let r=t==null?void 0:t.signal;if(r!=null&&r.aborted)throw new Error("Iris Relay: request aborted.");if(!this.settings.anthropicApiKey)throw new Error("Iris Relay: no API key configured.");if(this.queue.length>=ae)throw new Error("Iris Relay: queue full, try again later.");this.stats.totalRequests++;let i=z(e),s=typeof(t==null?void 0:t.priority)=="number"?Math.max(0,Math.min(10,t.priority)):he,c=t!=null&&t.trivial&&this.settings.trivialApiKey?this.settings.trivialApiKey:this.settings.anthropicApiKey,n=JSON.stringify(i),a=c+"\0"+n,h=this.responseCache.get(a);if(h&&Date.now()<h.expiresAt)return h.response;let m=(t==null?void 0:t.callerId)||se()||"?";return this.bumpCaller(m,"requests",1),new Promise((x,u)=>{let p={id:this.nextEntryId++,body:i,bodyKey:n,apiKey:c,cacheKey:a,priority:s,callerId:m,enqueuedAt:Date.now(),signal:r,resolve:x,reject:u};if(r){let S=()=>{let b=this.queue.indexOf(p);b!==-1&&(this.queue.splice(b,1),u(new Error("Iris Relay: request aborted.")))};p.abortHandler=S,r.addEventListener("abort",S,{once:!0})}let g=this.queue.findIndex(S=>S.priority>s);g===-1&&(g=this.queue.length),this.queue.splice(g,0,p),this.notifyChange(),this.scheduleDrain()})}scheduleDrain(){this.drainScheduled||(this.drainScheduled=!0,setTimeout(()=>{this.drainScheduled=!1,this.drain()},0))}cleanupAbortListener(e){e.signal&&e.abortHandler&&(e.signal.removeEventListener("abort",e.abortHandler),e.abortHandler=void 0)}maxConcurrencyFor(e){let t=this.rateLimitsRaw.get(e);return t?Math.max(1,Math.min(F,t.requestsLimit)):ce}getActive(e){return this.activeByKey.get(e)||0}adjustActive(e,t){var r;this.activeByKey.set(e,this.getActive(e)+t),this.activeTotal+=t,(r=this.activeListener)==null||r.call(this,this.activeTotal)}setActiveListener(e){this.activeListener=e}setChangeListener(e){this.changeListener=e}notifyChange(){this.changePending||(this.changePending=!0,queueMicrotask(()=>{var e;this.changePending=!1,(e=this.changeListener)==null||e.call(this)}))}getActiveCount(){return this.activeTotal}isPaused(){return this.paused}setPaused(e){this.paused!==e&&(this.paused=e,this.notifyChange(),e||this.scheduleDrain())}drain(){var i;if(this.paused)return;let e=Date.now(),t=1/0,r=0;for(;r<this.queue.length;){let s=this.queue[r];if((i=s.signal)!=null&&i.aborted){this.queue.splice(r,1);continue}let{apiKey:c}=s,n=this.rateLimitUntil.get(c)||0;if(e<n){t=Math.min(t,n),r++;continue}if(this.getActive(c)>=this.maxConcurrencyFor(c)){r++;continue}if(this.shouldThrottle(c)){t=Math.min(t,e+2e3),r++;continue}this.queue.splice(r,1),this.cleanupAbortListener(s),this.adjustActive(c,1);let a={id:s.id,callerId:s.callerId,model:String(s.body.model||"?"),role:this.settings.trivialApiKey&&c===this.settings.trivialApiKey?"trivial":"main",priority:s.priority,startedAt:Date.now(),cancelled:!1};this.activeRecords.set(s.id,a),this.notifyChange(),this.execute(s,a).finally(()=>{this.activeRecords.delete(s.id),this.adjustActive(c,-1),this.drain()})}t<1/0&&setTimeout(()=>this.drain(),t-Date.now())}shouldThrottle(e){let t=this.rateLimitsRaw.get(e);if(!t)return!1;let r=Date.now();return r>=t.tokensReset&&r>=t.requestsReset?!1:t.tokensRemaining<t.tokensLimit*.1||t.requestsRemaining<t.requestsLimit*.1}updateRateLimits(e,t){let r=h=>(t==null?void 0:t[h])||"",i=h=>{if(!h)return 0;let m=new Date(h);return isNaN(m.getTime())?0:m.getTime()},s=parseInt(r("anthropic-ratelimit-requests-limit"),10),c=parseInt(r("anthropic-ratelimit-tokens-limit"),10);if(isNaN(s)||isNaN(c))return;let n=parseInt(r("anthropic-ratelimit-requests-remaining"),10),a=parseInt(r("anthropic-ratelimit-tokens-remaining"),10);this.rateLimitsRaw.set(e,{requestsLimit:s,requestsRemaining:isNaN(n)?s:n,requestsReset:i(r("anthropic-ratelimit-requests-reset")),tokensLimit:c,tokensRemaining:isNaN(a)?c:a,tokensReset:i(r("anthropic-ratelimit-tokens-reset"))})}cacheResponse(e,t){let r=Date.now();for(let[i,s]of this.responseCache)r>=s.expiresAt&&this.responseCache.delete(i);if(this.responseCache.size>=ue){let i=this.responseCache.keys().next().value;i!==void 0&&this.responseCache.delete(i)}this.responseCache.set(e,{response:t,expiresAt:r+le})}async execute(e,t){try{await this.executeInner(e,t)}catch(r){}}applyOverloadBackoff(e,t,r){let i=parseInt((t==null?void 0:t["retry-after"])||"",10),s=(isNaN(i)?10:i)*1e3;this.rateLimitUntil.set(e,Date.now()+s);let c=r===429?"rate limited":"overloaded";return new Error(`Iris Relay: ${c} (${r}), backing off ${s/1e3}s`)}async executeInner(e,t){var h,m,x;let r=null,i=JSON.stringify(Q(e.body)),{apiKey:s,cacheKey:c,signal:n}=e,a=(u,p)=>{throw u.__irisHandled=!0,p==="error"&&(this.stats.errors++,this.bumpCaller(t.callerId,"errors",1)),e.reject(u),this.recordHistory(t,p,void 0,u.message),u};for(let u=0;u<=M;u++){if(t.cancelled&&a(new Error("Iris Relay: request cancelled."),"cancelled"),n!=null&&n.aborted&&a(new Error("Iris Relay: request aborted."),"cancelled"),u>0){this.bumpCaller(t.callerId,"retries",1);let b=ne*Math.pow(2,u-1);await new Promise(y=>setTimeout(y,b))}let p=Date.now(),g=this.rateLimitUntil.get(s)||0;p<g&&await new Promise(b=>setTimeout(b,g-p));let S;this.stats.attempts++;try{let b=[(0,C.requestUrl)({url:te,method:"POST",headers:{"Content-Type":"application/json","x-api-key":s,"anthropic-version":P,"anthropic-beta":"prompt-caching-2024-07-31"},body:i,throw:!1}),new Promise((w,k)=>{S=setTimeout(()=>k(new Error(`Iris Relay: request timed out after ${this.settings.requestTimeoutMs/1e3}s`)),this.settings.requestTimeoutMs)})],y=await Promise.race(b);if(t.cancelled&&a(new Error("Iris Relay: request cancelled."),"cancelled"),this.updateRateLimits(s,y.headers),y.status===429||y.status===529){r=this.applyOverloadBackoff(s,y.headers,y.status);continue}if(y.status>=500){r=new Error(`Iris Relay: server error ${y.status}`);continue}if(y.status>=400){let w=(x=(m=(h=y.json)==null?void 0:h.error)==null?void 0:m.message)!=null?x:`API ${y.status}`;a(new Error(`Iris Relay: ${w}`),"error")}return this.cacheResponse(c,y.json),e.resolve(y.json),this.recordHistory(t,"ok",y.json),y.json}catch(b){if(b instanceof Error&&b.__irisHandled)throw b;if(r=b instanceof Error?b:new Error(String(b)),u<M&&r.message.includes("timed out"))continue;if(u>=M)break}finally{S!==void 0&&clearTimeout(S)}}throw a(r||new Error("Iris Relay: all retries exhausted"),"error"),r}getCallerStats(e){let t=this.callerStats.get(e);return t||(t={requests:0,errors:0,retries:0,cancelled:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0},this.callerStats.set(e,t)),t}bumpCaller(e,t,r){let i=this.getCallerStats(e);i[t]+=r}recordHistory(e,t,r,i,s="sync"){let c=(r==null?void 0:r.usage)||{},n=Number(c.input_tokens)||0,a=Number(c.output_tokens)||0,h=Number(c.cache_read_input_tokens)||0,m=Number(c.cache_creation_input_tokens)||0,x={id:e.id,callerId:e.callerId,model:e.model,role:e.role,priority:e.priority,mode:s,startedAt:e.startedAt,endedAt:Date.now(),status:t,inputTokens:n,outputTokens:a,cacheReadTokens:h,cacheCreationTokens:m,error:i,customId:e.customId};this.history.push(x),this.history.length>B&&this.history.splice(0,this.history.length-B);let u=this.getCallerStats(e.callerId);u.inputTokens+=n,u.outputTokens+=a,u.cacheReadTokens+=h,u.cacheCreationTokens+=m,t==="cancelled"&&(u.cancelled+=1),this.notifyChange()}cancelQueued(e){let t=this.queue.findIndex(s=>s.id===e);if(t===-1)return!1;let[r]=this.queue.splice(t,1);this.cleanupAbortListener(r);let i=new Error("Iris Relay: request cancelled.");return r.reject(i),this.bumpCaller(r.callerId,"cancelled",1),this.history.push({id:r.id,callerId:r.callerId,model:String(r.body.model||"?"),role:this.settings.trivialApiKey&&r.apiKey===this.settings.trivialApiKey?"trivial":"main",priority:r.priority,mode:"sync",startedAt:r.enqueuedAt,endedAt:Date.now(),status:"cancelled",inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0,error:"cancelled before dispatch"}),this.history.length>B&&this.history.splice(0,this.history.length-B),this.notifyChange(),!0}cancelActive(e){let t=this.activeRecords.get(e);return t?(t.cancelled=!0,this.notifyChange(),!0):!1}cancelBatchQueued(e,t){let r=this.batchState.queued.length;return this.batchState.queued=this.batchState.queued.filter(i=>!(i.callerId===e&&i.customId===t)),this.batchState.queued.length===r?!1:(this.saveBatchState(),this.notifyChange(),!0)}async cancelBatchPending(e){let t=this.batchState.pending.find(i=>i.batchId===e);if(!t)return!1;let r=this.resolveKey(t.role);if(!r)return!1;try{await(0,C.requestUrl)({url:`${L}/${e}/cancel`,method:"POST",headers:{"x-api-key":r,"anthropic-version":P},throw:!1})}catch(i){console.warn("Iris Relay: batch cancel request failed",i)}return!0}resolveKey(e){return e==="trivial"&&this.settings.trivialApiKey?this.settings.trivialApiKey:this.settings.anthropicApiKey}async saveBatchState(){if(this.persistBatch)try{await this.persistBatch(this.batchState)}catch(e){console.error("Iris Relay: failed to persist batch state",e)}}enqueueBatch(e,t){if(!t||!t.customId||!t.callerId)throw new Error("Iris Relay: enqueueBatch requires customId and callerId.");let r=z(e);this.batchState.queued.push({customId:t.customId,callerId:t.callerId,trivial:!!t.trivial,body:r}),this.bumpCaller(t.callerId,"requests",1),this.saveBatchState(),this.notifyChange()}async flushBatch(e){var h,m,x,u;let t=e!=null&&e.trivial?"trivial":"main",r=this.resolveKey(t);if(!r)throw new Error("Iris Relay: no API key configured.");let i=!!(e!=null&&e.trivial),s=this.batchState.queued.filter(p=>p.trivial===i);if(s.length===0)return null;let c=s.map(p=>({custom_id:p.customId,params:Q(p.body)})),n;try{n=await(0,C.requestUrl)({url:L,method:"POST",headers:{"Content-Type":"application/json","x-api-key":r,"anthropic-version":P,"anthropic-beta":"prompt-caching-2024-07-31"},body:JSON.stringify({requests:c}),throw:!1})}catch(p){throw new Error(`Iris Relay: batch submit failed: ${p instanceof Error?p.message:String(p)}`)}if(this.updateRateLimits(r,n.headers),n.status>=400){let p=(x=(m=(h=n.json)==null?void 0:h.error)==null?void 0:m.message)!=null?x:`API ${n.status}`;throw new Error(`Iris Relay: batch submit failed: ${p}`)}let a=(u=n.json)==null?void 0:u.id;if(typeof a!="string")throw new Error("Iris Relay: batch submit returned no id.");return this.batchState.queued=this.batchState.queued.filter(p=>p.trivial!==i),this.batchState.pending.push({batchId:a,role:t,submittedAt:Date.now(),entries:s.map(p=>({customId:p.customId,callerId:p.callerId}))}),await this.saveBatchState(),this.notifyChange(),this.schedulePoll(a,j),a}onBatchResult(e,t){this.batchHandlers.set(e,t);let r=this.batchBuffered.get(e);if(r){this.batchBuffered.delete(e);for(let{customId:i,result:s}of r)try{t(i,s)}catch(c){console.error("Iris Relay: batch handler threw",c)}}return()=>{this.batchHandlers.get(e)===t&&this.batchHandlers.delete(e)}}getLiveSnapshot(){let e=this.settings.trivialApiKey,t=r=>e&&r===e?"trivial":"main";return{active:Array.from(this.activeRecords.values()).map(r=>({id:r.id,callerId:r.callerId,model:r.model,role:r.role,priority:r.priority,startedAt:r.startedAt,cancelled:r.cancelled})),queued:this.queue.map(r=>({id:r.id,model:String(r.body.model||"?"),role:t(r.apiKey),priority:r.priority,callerId:r.callerId})),batchQueued:this.batchState.queued.map(r=>({model:String(r.body.model||"?"),role:r.trivial?"trivial":"main",callerId:r.callerId,customId:r.customId})),batchPending:this.batchState.pending.map(r=>({batchId:r.batchId,entries:r.entries.length,submittedAt:r.submittedAt,role:r.role,items:r.entries.map(i=>({customId:i.customId,callerId:i.callerId}))})),history:this.history.slice().reverse(),callerStats:Array.from(this.callerStats.entries()).map(([r,i])=>({callerId:r,...i})).sort((r,i)=>i.requests-r.requests),stats:{...this.stats}}}getBatchState(){return{queued:this.batchState.queued.length,pending:this.batchState.pending.map(e=>({batchId:e.batchId,entries:e.entries.length,submittedAt:e.submittedAt,role:e.role}))}}resumePending(){this.batchState.queued.length>0&&console.log(`Iris Relay: ${this.batchState.queued.length} batch entries queued (awaiting flush).`);for(let e of this.batchState.pending)this.schedulePoll(e.batchId,0)}schedulePoll(e,t){if(this.shutdownFlag)return;let r=this.batchPollTimers.get(e);r&&clearTimeout(r);let i=setTimeout(()=>{this.batchPollTimers.delete(e),this.pollBatch(e)},t);this.batchPollTimers.set(e,i)}async pollBatch(e){var m,x,u,p;if(this.shutdownFlag)return;let t=this.batchState.pending.find(g=>g.batchId===e);if(!t)return;let r=this.resolveKey(t.role);if(!r){console.warn(`Iris Relay: cannot poll batch ${e}, ${t.role} key missing.`),this.schedulePoll(e,T);return}let i;try{i=await(0,C.requestUrl)({url:`${L}/${e}`,method:"GET",headers:{"x-api-key":r,"anthropic-version":P},throw:!1})}catch(g){console.warn(`Iris Relay: batch ${e} status fetch failed`,g),this.schedulePoll(e,T);return}if(i.status>=400){console.warn(`Iris Relay: batch ${e} status ${i.status}`),this.schedulePoll(e,T);return}if(((m=i.json)==null?void 0:m.processing_status)!=="ended"){let S=Date.now()-t.submittedAt<re?j:T;this.schedulePoll(e,S);return}let c;try{c=await(0,C.requestUrl)({url:`${L}/${e}/results`,method:"GET",headers:{"x-api-key":r,"anthropic-version":P},throw:!1})}catch(g){console.warn(`Iris Relay: batch ${e} results fetch failed`,g),this.schedulePoll(e,T);return}if(c.status>=400){console.warn(`Iris Relay: batch ${e} results status ${c.status}`),this.schedulePoll(e,T);return}let a=(c.text||"").split(`
`).filter(g=>g.trim().length>0),h=new Map(t.entries.map(g=>[g.customId,g.callerId]));for(let g of a){let S;try{S=JSON.parse(g)}catch(o){continue}let b=S.custom_id,y=h.get(b);if(!y)continue;let w=S.result,k,I="ok",R,l;(w==null?void 0:w.type)==="succeeded"?(k={ok:!0,response:w.message},R=w.message):(w==null?void 0:w.type)==="errored"?(l=((u=(x=w.error)==null?void 0:x.error)==null?void 0:u.message)||((p=w.error)==null?void 0:p.message)||"errored",k={ok:!1,error:l},I="error",this.bumpCaller(y,"errors",1)):(w==null?void 0:w.type)==="canceled"?(l="canceled",k={ok:!1,error:l},I="cancelled"):(w==null?void 0:w.type)==="expired"?(l="expired",k={ok:!1,error:l},I="error",this.bumpCaller(y,"errors",1)):(l="unknown result type",k={ok:!1,error:l},I="error"),this.recordHistory({id:this.nextEntryId++,callerId:y,model:String((R==null?void 0:R.model)||"?"),role:t.role,priority:0,startedAt:t.submittedAt,customId:b},I,R,l,"batch"),this.dispatchBatchResult(y,b,k)}this.batchState.pending=this.batchState.pending.filter(g=>g.batchId!==e),await this.saveBatchState(),this.notifyChange()}dispatchBatchResult(e,t,r){let i=this.batchHandlers.get(e);if(i){try{i(t,r)}catch(c){console.error("Iris Relay: batch handler threw",c)}return}let s=this.batchBuffered.get(e);s||(s=[],this.batchBuffered.set(e,s)),s.push({customId:t,result:r})}};function X(d){if(!d)return"";try{let{safeStorage:e}=require("electron");if(e.isEncryptionAvailable())return"enc:"+e.encryptString(d).toString("base64")}catch(e){}return d}function Y(d){if(!d)return"";if(d.startsWith("enc:"))try{let{safeStorage:e}=require("electron");return e.decryptString(Buffer.from(d.slice(4),"base64"))}catch(e){return new f.Notice("Iris Relay: unable to decrypt API key. Please re-enter it in settings."),""}return d}var pe={anthropicApiKey:"",trivialApiKey:"",requestTimeoutSec:60},_=class extends f.Plugin{constructor(){super(...arguments);this.batchState=D()}async onload(){await this.loadSettings(),this.relay=new $(this.relaySettings(),{initial:this.batchState,save:async i=>{this.batchState=i,await this.persistAll()}}),this.relay.resumePending(),this.app.irisRelay=this.relay;let t=document.createElement("style");t.textContent=`
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
      .iris-modal-status { display: flex; align-items: center; gap: 8px; }
      .iris-modal-status.is-active { color: var(--interactive-accent); font-weight: 600; }
      .iris-modal-status.is-paused { color: var(--text-warning, var(--text-accent)); font-weight: 600; }
      .iris-pause-btn {
        margin-left: auto;
        font-size: 11px;
        padding: 2px 8px;
        height: auto;
        line-height: 1.4;
      }

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
    `,document.head.appendChild(t),this.register(()=>t.remove());let r=this.addStatusBarItem();r.addClass("iris-status"),(0,f.setIcon)(r,"brain-circuit"),r.addEventListener("click",()=>{new O(this.app,this.relay).open()}),this.relay.setActiveListener(i=>{r.toggleClass("is-active",i>0),r.setAttr("aria-label",i>0?`Iris: ${i} request${i===1?"":"s"} in flight`:"Iris: idle")}),this.addSettingTab(new N(this.app,this))}onunload(){this.relay.shutdown(),delete this.app.irisRelay}relaySettings(){return{anthropicApiKey:this.settings.anthropicApiKey,trivialApiKey:this.settings.trivialApiKey,requestTimeoutMs:this.settings.requestTimeoutSec*1e3}}async loadSettings(){let t=await this.loadData()||{};t.batchState&&Array.isArray(t.batchState.queued)&&Array.isArray(t.batchState.pending)&&(this.batchState=t.batchState);let{batchState:r,...i}=t,s=Object.assign({},pe,i);s.anthropicApiKey=Y(s.anthropicApiKey),s.trivialApiKey=Y(s.trivialApiKey||""),this.settings=s}async persistAll(){let t={...this.settings};t.anthropicApiKey=X(t.anthropicApiKey),t.trivialApiKey=X(t.trivialApiKey),t.batchState=this.batchState,await this.saveData(t)}async saveSettings(){await this.persistAll(),this.relay.updateSettings(this.relaySettings())}},N=class extends f.PluginSettingTab{constructor(e,t){super(e,t),this.plugin=t}display(){let{containerEl:e}=this;e.empty();let t=this.plugin.settings,r=()=>this.plugin.saveSettings();e.createEl("h3",{text:"Iris AI Router"}),e.createEl("p",{text:"Centralised AI API router for iris plugins. Other iris plugins will automatically route requests through this plugin when enabled.",cls:"setting-item-description"}),new f.Setting(e).setName("Anthropic API key").setDesc("Shared API key used by all iris plugins routed through this relay.").addText(n=>{n.inputEl.type="password",n.setPlaceholder("sk-ant-...").setValue(t.anthropicApiKey).onChange(async a=>{t.anthropicApiKey=a.trim(),await r()})}),new f.Setting(e).setName("Trivial API key").setDesc("Optional separate API key for trivial calls (e.g. nickname generation). Falls back to the main key when empty.").addText(n=>{n.inputEl.type="password",n.setPlaceholder("sk-ant-...").setValue(t.trivialApiKey).onChange(async a=>{t.trivialApiKey=a.trim(),await r()})}),new f.Setting(e).setName("Request timeout").setDesc("Seconds before a single API request times out.").addDropdown(n=>n.addOption("30","30s").addOption("60","60s").addOption("90","90s").addOption("120","120s").setValue(String(t.requestTimeoutSec)).onChange(async a=>{t.requestTimeoutSec=parseInt(a,10),await r()}));let i=this.plugin.relay.getRateLimits();if(i.length>0){e.createEl("h4",{text:"API rate limits"});for(let n of i){let a=n.role==="main"?"Main key":"Trivial key",h=n.requestsLimit>0?Math.round(n.requestsRemaining/n.requestsLimit*100):100,m=n.tokensLimit>0?Math.round(n.tokensRemaining/n.tokensLimit*100):100,x=`Requests: ${n.requestsRemaining.toLocaleString()} / ${n.requestsLimit.toLocaleString()} remaining (${h}%) \xB7 Tokens: ${n.tokensRemaining.toLocaleString()} / ${n.tokensLimit.toLocaleString()} remaining (${m}%) \xB7 Concurrency: ${n.concurrency}`;new f.Setting(e).setName(a).setDesc(x)}}let s=this.plugin.relay.getBatchState();if(e.createEl("h4",{text:"Batch mode"}),e.createEl("p",{text:"Iris plugins can enqueue requests for the cheaper async batches API. Results are delivered within 24h; Obsidian must be running for polling to advance.",cls:"setting-item-description"}),new f.Setting(e).setName("Queued").setDesc(`${s.queued} request${s.queued===1?"":"s"} waiting to be flushed`).addButton(n=>n.setButtonText("Flush main").onClick(async()=>{try{let a=await this.plugin.relay.flushBatch();new f.Notice(a?`Iris: submitted batch ${a}`:"Iris: queue empty")}catch(a){new f.Notice(`Iris: ${a instanceof Error?a.message:String(a)}`)}this.display()})).addButton(n=>n.setButtonText("Flush trivial").onClick(async()=>{try{let a=await this.plugin.relay.flushBatch({trivial:!0});new f.Notice(a?`Iris: submitted batch ${a}`:"Iris: queue empty")}catch(a){new f.Notice(`Iris: ${a instanceof Error?a.message:String(a)}`)}this.display()})),s.pending.length>0)for(let n of s.pending){let a=Math.round((Date.now()-n.submittedAt)/6e4);new f.Setting(e).setName(`Pending ${n.batchId}`).setDesc(`${n.entries} request${n.entries===1?"":"s"} \xB7 ${n.role} key \xB7 submitted ${a} min ago`)}let c=this.plugin.relay.getStats();c.totalRequests>0&&(e.createEl("h4",{text:"Session stats"}),new f.Setting(e).setName("Totals").setDesc(`${c.totalRequests} requests \xB7 ${c.errors} errors`))}},O=class extends f.Modal{constructor(e,t){super(e),this.relay=t}onOpen(){this.titleEl.setText("Iris Router"),this.modalEl.addClass("iris-modal"),this.modalEl.style.width="min(640px, 95vw)",this.render(),this.relay.setChangeListener(()=>this.render()),this.ageTicker=window.setInterval(()=>this.tickAges(),1e3)}onClose(){this.relay.setChangeListener(void 0),this.ageTicker!==void 0&&window.clearInterval(this.ageTicker),this.contentEl.empty()}tickAges(){let e=Date.now();this.contentEl.querySelectorAll("[data-started-at]").forEach(t=>{let r=parseInt(t.dataset.startedAt,10);isNaN(r)||(t.textContent=this.fmtAge(e-r))})}fmtAge(e){let t=Math.max(0,Math.round(e/1e3));if(t<60)return`${t}s`;let r=Math.floor(t/60);return r<60?`${r}m ${t%60}s`:`${Math.floor(r/60)}h ${r%60}m`}fmtTime(e){return new Date(e).toLocaleTimeString()}fmtNum(e){return e.toLocaleString()}fmtTokens(e){return e<1e3?String(e):e<1e6?`${(e/1e3).toFixed(e<1e4?1:0)}k`:`${(e/1e6).toFixed(1)}M`}section(e,t,r,i=!1){let s=e.createDiv({cls:"iris-section"}),c=s.createDiv({cls:"iris-section-title"});if(c.createSpan({text:t}),r!==void 0){let n=c.createSpan({cls:"iris-count",text:String(r)});i&&n.addClass("is-active")}return s}rolePill(e,t,r){e.createSpan({cls:`iris-row-role role-${t} status-${t}`,text:r!=null?r:t})}callerCell(e,t,r){let i=e.createDiv({cls:"iris-row-caller"});i.createEl("b",{text:t}),r&&i.createSpan({cls:"iris-row-model",text:r})}render(){let e=this.relay.getLiveSnapshot(),t=this.relay.getRateLimits(),r=this.relay.getBatchState(),i=Date.now(),s=document.createElement("div"),c=s.createDiv({cls:"iris-modal-status"}),n=e.active.length,a=e.queued.length,h=this.relay.isPaused(),m=c.createSpan();if(h){c.addClass("is-paused");let l=["paused"];n>0&&l.push(`${n} in flight`),a>0&&l.push(`${a} queued`),m.textContent=l.join(" \xB7 ")}else if(n>0||a>0){c.addClass("is-active");let l=[];n>0&&l.push(`${n} in flight`),a>0&&l.push(`${a} queued`),m.textContent=l.join(" \xB7 ")}else m.textContent="idle";if(c.createEl("button",{cls:"iris-pause-btn",text:h?"Resume":"Pause",attr:{title:h?"Resume dispatching queued requests":"Stop dispatching queued requests"}}).addEventListener("click",()=>this.relay.setPaused(!h)),t.length>0){let l=this.section(s,"Rate limits");for(let o of t)this.renderLimit(l,o)}let u=this.section(s,"Active",n,n>0);if(n===0)u.createDiv({text:"no requests in flight",cls:"iris-section-empty"});else for(let l of e.active){let o=u.createDiv({cls:`iris-row${l.cancelled?" status-cancelled":""}`});this.rolePill(o,l.role),this.callerCell(o,l.callerId,l.model);let v=o.createSpan({cls:"iris-row-meta"});v.dataset.startedAt=String(l.startedAt),v.textContent=this.fmtAge(i-l.startedAt),l.cancelled?o.createSpan():o.createEl("button",{cls:"iris-row-cancel",text:"\u2715",attr:{title:"Cancel"}}).addEventListener("click",()=>this.relay.cancelActive(l.id))}if(a>0){let l=this.section(s,"Queued",a);for(let o of e.queued){let v=l.createDiv({cls:"iris-row"});this.rolePill(v,o.role),this.callerCell(v,o.callerId,o.model),v.createSpan({cls:"iris-row-meta",text:`p${o.priority}`}),v.createEl("button",{cls:"iris-row-cancel",text:"\u2715",attr:{title:"Cancel"}}).addEventListener("click",()=>this.relay.cancelQueued(o.id))}}if(r.queued>0||e.batchPending.length>0||e.history.some(l=>l.mode==="batch")){let l=this.section(s,"Batch"),o=l.createDiv({cls:"iris-batch-controls"});o.createSpan({text:`${r.queued} queued`});let v=o.createEl("button",{cls:"iris-batch-btn",text:"Flush main"});v.disabled=r.queued===0,v.addEventListener("click",()=>this.flush(!1));let q=o.createEl("button",{cls:"iris-batch-btn",text:"Flush trivial"});q.disabled=r.queued===0,q.addEventListener("click",()=>this.flush(!0));for(let A of e.batchPending){let E=l.createDiv({cls:"iris-row"});this.rolePill(E,A.role),this.callerCell(E,A.batchId,`${A.entries} item${A.entries===1?"":"s"}`);let H=E.createSpan({cls:"iris-row-meta"});H.dataset.startedAt=String(A.submittedAt),H.textContent=this.fmtAge(i-A.submittedAt),E.createSpan()}}let g=e.callerStats.filter(l=>l.requests>0).slice(0,5);if(g.length>0){let l=this.section(s,"Callers");for(let o of g){let v=l.createDiv({cls:"iris-caller-row"});this.callerCell(v,o.callerId),v.createSpan({cls:"iris-row-meta",text:`${o.requests} req`}),v.createSpan({cls:`iris-row-meta${o.errors>0?" is-error":""}`,text:o.errors>0?`${o.errors} err`:"\u2014"}),v.createSpan({cls:"iris-row-meta",text:`${this.fmtTokens(o.inputTokens)} in \xB7 ${this.fmtTokens(o.outputTokens)} out`})}}let S=e.history.slice(0,15);if(S.length>0){let l=this.section(s,"Recent");for(let o of S){let v=l.createDiv({cls:`iris-row status-${o.status}`}),q=o.status==="ok"?"ok":o.status==="error"?"err":"canc";this.rolePill(v,o.status,q),this.callerCell(v,o.callerId,o.model);let A=Math.max(0,o.endedAt-o.startedAt),E=o.status==="error"&&o.error?o.error.length>36?o.error.slice(0,36)+"\u2026":o.error:`${(A/1e3).toFixed(1)}s`;v.createSpan({cls:`iris-row-meta${o.status==="error"?" is-error":""}`,text:E}),v.createSpan({cls:"iris-row-meta",text:this.fmtTime(o.endedAt)})}}let b=e.stats,y=e.callerStats.reduce((l,o)=>l+o.inputTokens,0),w=e.callerStats.reduce((l,o)=>l+o.outputTokens,0),k=e.callerStats.reduce((l,o)=>l+o.cacheReadTokens,0),I=s.createDiv({cls:"iris-footer"}),R=(l,o)=>{let v=I.createSpan();v.createSpan({text:`${l} `}),v.createEl("b",{text:typeof o=="number"?this.fmtNum(o):o})};R("Requests",b.totalRequests),R("Attempts",b.attempts),R("Failures",b.errors),R("Input",this.fmtTokens(y)),R("Output",this.fmtTokens(w)),k>0&&R("Cache read",this.fmtTokens(k)),this.contentEl.replaceChildren(s)}renderLimit(e,t){let r=e.createDiv({cls:"iris-limit-row"});this.rolePill(r,t.role);let i=(s,c,n,a)=>{let h=r.createDiv(),m=h.createDiv({cls:"iris-limit-label"});m.createSpan({text:s}),m.createEl("b",{text:n>0?`${a(c)} / ${a(n)}`:"\u2014"});let x=h.createDiv({cls:"iris-limit-bar"}),u=n>0?Math.max(0,Math.min(1,c/n)):1;u<.1?x.addClass("crit"):u<.3&&x.addClass("low"),x.createSpan().style.width=`${Math.max(2,u*100)}%`};i("Requests",t.requestsRemaining,t.requestsLimit,s=>this.fmtNum(s)),i("Tokens",t.tokensRemaining,t.tokensLimit,s=>this.fmtTokens(s)),r.createSpan({cls:"iris-row-meta",text:`conc ${t.concurrency}`})}async flush(e){try{let t=await this.relay.flushBatch(e?{trivial:!0}:void 0);new f.Notice(t?`Iris: submitted batch ${t}`:"Iris: queue empty")}catch(t){new f.Notice(`Iris: ${t instanceof Error?t.message:String(t)}`)}this.render()}};
