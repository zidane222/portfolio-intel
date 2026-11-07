// Admin page for pi-flags. No inline script or style (CSP script-src 'self'), no outside hosts.
// All text from the server is set with textContent, never innerHTML.
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Portfolio Intel flags</title>
<link rel="stylesheet" href="/admin/app.css"></head>
<body><main>
<h1>Feature flags</h1>
<p class="note">Changes reach the app within about a minute.</p>
<p id="status" role="status" aria-live="polite"></p>
<label for="reason">Reason (3 to 200 characters, required)</label>
<input id="reason" required minlength="3" maxlength="200" aria-describedby="status" autocomplete="off" placeholder="Why are you changing this?">
<ul id="flags"></ul>
<h2>Last 20 changes</h2>
<ol id="audit"></ol>
</main><script src="/admin/app.js"></script></body></html>`;

export const STYLE = `*{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#0f1115;color:#e8eaf0}
main{max-width:560px;margin:0 auto;padding:16px}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:28px}
.note{color:#9aa3b2}label{display:block;margin:12px 0 6px}input{width:100%;min-height:44px;font-size:16px;padding:8px 12px;border-radius:10px;border:1px solid #3a4150;background:#161a22;color:inherit}
ul{list-style:none;padding:0}li.flag{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #252a35}
.name{font-weight:600}.meta{color:#9aa3b2;font-size:.85rem}
button{min-width:96px;min-height:48px;font-size:1rem;font-weight:700;border-radius:24px;border:0;cursor:pointer}
button.on{background:#1f9d55;color:#fff}button.off{background:#c53030;color:#fff}button:disabled{opacity:.5}
button:focus-visible,input:focus-visible{outline:3px solid #7aa2ff;outline-offset:2px}
#status{min-height:1.4em;color:#ffd479}ol{padding-left:20px;color:#c3c9d4;font-size:.9rem}ol li{margin:6px 0}`;

export const SCRIPT = `(function(){
var state=null;var $=function(id){return document.getElementById(id)};
function say(t){$('status').textContent=t}
var ENDED='Your session ended. Reload the page to sign in again.';
function body(r){var ct=r.headers.get('content-type')||'';if(ct.indexOf('application/json')<0){var e=new Error(ENDED);e.ended=true;throw e}return r.json()}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
function render(){var ul=$('flags');ul.textContent='';Object.keys(state.flags).forEach(function(n){var f=state.flags[n];
var li=el('li','flag');var left=el('div');left.appendChild(el('div','name',n));left.appendChild(el('div','meta',f.label));
if(f.at)left.appendChild(el('div','meta','Last change '+f.at.slice(0,16).replace('T',' ')+' UTC: '+(f.reason||'')));
var b=el('button',f.on?'on':'off',f.on?'On':'Off');b.type='button';b.setAttribute('aria-pressed',f.on?'true':'false');
b.setAttribute('aria-label',n);b.setAttribute('data-flag',n);
b.onclick=function(){flip(n,!f.on,b)};li.appendChild(left);li.appendChild(b);ul.appendChild(li)})}
function refocus(n){var b=document.querySelector('#flags button[data-flag="'+n+'"]');if(b)b.focus()}
function audit(){var ol=$('audit');fetch('/admin/audit',{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return body(r)}).then(function(d){ol.textContent='';
(d.audit||[]).forEach(function(a){ol.appendChild(el('li',null,a.at.slice(0,16).replace('T',' ')+' '+a.name+' '+(a.on?'on':'off')+' by '+a.by+': '+a.reason))})}).catch(function(e){ol.textContent='';ol.appendChild(el('li',null,e.ended?ENDED:'Could not load recent changes.'))})}
function load(){fetch('/admin/flags',{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return body(r)})
.then(function(d){state=d;render();audit()}).catch(function(e){say(e.ended?ENDED:'Could not load flags: '+e.message)})}
$('reason').oninput=function(){if($('reason').value.trim().length>=3)$('reason').removeAttribute('aria-invalid')};
function flip(n,on,b){var reason=$('reason').value.trim();if(reason.length<3){$('reason').setAttribute('aria-invalid','true');say('Type a reason first (3 to 200 characters).');$('reason').focus();return}
$('reason').removeAttribute('aria-invalid');
b.disabled=true;say('Saving...');fetch('/admin/flags',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-PI-Flags':'1'},
body:JSON.stringify({name:n,on:on,reason:reason,v:state.v})}).then(function(r){return body(r).then(function(d){return{r:r,d:d}})})
.then(function(x){if(x.r.status===409){say(x.d.error);load();return}if(!x.r.ok){say(x.d.error||'Save failed');b.disabled=false;return}
state=x.d;$('reason').value='';render();refocus(n);audit();say(n+' is now '+(on?'on':'off')+'.')}).catch(function(e){say(e.ended?ENDED:'Save failed. Check your connection.');b.disabled=false})}
load()})();`;
