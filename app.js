// 矿山三语实时翻译助手 V0.4.1 FREE - iPhone 兼容版
// 关键修改：不在页面打开时静态加载 AI 库；用户点击初始化后动态加载。
// iPhone 上先只加载 Whisper，翻译模型按需加载，避免一次性占用过多内存。

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const NAMES = {zh:'中文', es:'Español', en:'English'};

let pipelineFn = null;
let hfEnv = null;
let ready = false;
let running = false;
let stream = null;
let audioCtx = null;
let analyser = null;
let mediaSource = null;
let vadTimer = null;
let recorder = null;
let chunks = [];
let speechSeen = false;
let silenceAt = 0;
let segmentStart = 0;
let queue = [];
let processing = false;
let asr = null;
let pipes = {};
let scene = 'drilling';
let current = {zh:'', es:'', en:'', source:''};

const MODELS = {
  asr: 'Xenova/whisper-tiny',
  zh_en: 'Xenova/opus-mt-zh-en',
  en_zh: 'Xenova/opus-mt-en-zh',
  es_en: 'Xenova/opus-mt-es-en',
  en_es: 'Xenova/opus-mt-en-es'
};

function toast(msg){
  const e = $('#toast');
  e.textContent = msg;
  e.classList.add('show');
  setTimeout(()=>e.classList.remove('show'), 3200);
}
function setProgress(p, text){
  $('#bar').style.width = Math.max(0, Math.min(100,p)) + '%';
  if(text) $('#progressText').textContent = text;
}
function detect(text){
  if(/[\u3400-\u9fff]/.test(text)) return 'zh';
  const s=' '+text.toLowerCase()+' ';
  const es=[' el ',' la ',' los ',' las ',' de ',' que ',' para ',' por ',' una ',' un ',' con ',' pero ',' porque ',' está ',' tenemos ',' sondaje ',' almacén ',' seguridad ',' mantenimiento ',' perforación '];
  const en=[' the ',' a ',' an ',' and ',' of ',' to ',' for ',' is ',' are ',' we ',' this ',' that ',' with ',' but ',' because ',' drill ',' warehouse ',' safety ',' maintenance '];
  const a=es.reduce((n,x)=>n+(s.includes(x)?1:0),0);
  const b=en.reduce((n,x)=>n+(s.includes(x)?1:0),0);
  if(a===b) return /[áéíóúñ¿¡]/i.test(text) ? 'es' : 'en';
  return a>b ? 'es' : 'en';
}
function markSource(lang){
  ['zh','es','en'].forEach(l=>{
    $(`#card-${l}`).classList.toggle('source', l===lang);
    $(`#tag-${l}`).textContent = l===lang ? (l==='es'?'Original':'原文') : (l==='es'?'Traducción':'译文');
  });
  if(lang) $('#micStatus').textContent = `🎙 当前识别：${NAMES[lang]} · 会议监听中`;
}
function render(){
  ['zh','es','en'].forEach(l=>{
    if(current[l]) $(`#${l}`).textContent = current[l];
  });
  markSource(current.source);
}
function esc(s=''){
  return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}
function addHistory(){
  const h=$('#history');
  if(h.querySelector('.muted')) h.innerHTML='';
  const d=document.createElement('div');
  d.className='turn';
  const tm=new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  d.innerHTML=`<div class="meta">${tm} · 原文：${NAMES[current.source]}</div>
  <p><b>🇨🇳 中文</b>${esc(current.zh)}</p>
  <p><b>🇵🇪 Español</b>${esc(current.es)}</p>
  <p><b>🇺🇸 English</b>${esc(current.en)}</p>`;
  h.prepend(d);
}

async function loadEngine(){
  if(pipelineFn) return;
  setProgress(2, '正在加载 iPhone 兼容版 AI 引擎…');
  // v2 系列在移动 Safari 上更保守，且支持 Xenova 量化模型。
  const mod = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
  pipelineFn = mod.pipeline;
  hfEnv = mod.env;
  if(hfEnv){
    hfEnv.allowLocalModels = false;
    hfEnv.useBrowserCache = true;
  }
}

async function init(){
  if(ready){
    toast('模型已经初始化完成');
    return;
  }
  const btn=$('#loadModels');
  btn.disabled=true;
  $('#engineStatus').textContent='正在启动 iPhone 兼容模式…';
  try{
    await loadEngine();
    setProgress(8, '正在下载/读取 Whisper Tiny 语音识别模型…');
    asr = await pipelineFn('automatic-speech-recognition', MODELS.asr, {
      quantized: true,
      progress_callback: x => {
        if(x?.status === 'progress'){
          const p = 8 + Math.min(88, (x.progress || 0) * 0.88);
          setProgress(p, `语音模型：${x.file || '下载中'} · ${Math.round(x.progress || 0)}%`);
        }
      }
    });
    ready=true;
    setProgress(100, '✅ 语音模型已就绪。翻译模型会在第一次需要时自动下载并缓存。');
    $('#engineStatus').textContent='✅ iPhone兼容模式已就绪';
    $('#talk').disabled=false;
    btn.textContent='✅ 已初始化';
    toast('初始化完成，可以开始会议翻译');
  }catch(e){
    console.error(e);
    $('#engineStatus').textContent='❌ 初始化失败';
    setProgress(0, `错误：${e?.message || e}`);
    btn.disabled=false;
    toast('初始化失败，请看页面错误提示');
  }
}

async function getPipe(key){
  if(pipes[key]) return pipes[key];
  if(!pipelineFn) await loadEngine();
  const labels={zh_en:'中文→英语',en_zh:'英语→中文',es_en:'西语→英语',en_es:'英语→西语'};
  const label=labels[key];
  $('#engineStatus').textContent=`首次加载翻译模型：${label}`;
  setProgress(10, `正在下载 ${label} 免费模型…`);
  const p = await pipelineFn('translation', MODELS[key], {
    quantized:true,
    progress_callback:x=>{
      if(x?.status==='progress'){
        setProgress(10 + Math.min(88,(x.progress||0)*0.88), `${label}：${Math.round(x.progress||0)}%`);
      }
    }
  });
  pipes[key]=p;
  $('#engineStatus').textContent='✅ 免费本地模型运行中';
  setProgress(100, `${label} 已加载并缓存`);
  return p;
}
async function tr(key,text){
  const p=await getPipe(key);
  const r=await p(text,{max_new_tokens:256});
  return r?.[0]?.translation_text || r?.[0]?.generated_text || '';
}
async function translateAll(text){
  const l=detect(text);
  current={zh:'',es:'',en:'',source:l};
  $('#micStatus').textContent='🧠 正在本机翻译…';
  if(l==='zh'){
    current.zh=text;
    current.en=await tr('zh_en',text);
    current.es=await tr('en_es',current.en);
  }else if(l==='es'){
    current.es=text;
    current.en=await tr('es_en',text);
    current.zh=await tr('en_zh',current.en);
  }else{
    current.en=text;
    current.zh=await tr('en_zh',text);
    current.es=await tr('en_es',text);
  }
  render();
  addHistory();
  speakOut();
}
function speakOut(){
  const l=$('#speakLang').value;
  if(l==='off'||l===current.source||!current[l]) return;
  try{
    speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(current[l]);
    u.lang=l==='zh'?'zh-CN':l==='es'?'es-PE':'en-US';
    speechSynthesis.speak(u);
  }catch(e){ console.warn(e); }
}

function newRecorder(){
  chunks=[];
  recorder=new MediaRecorder(stream);
  recorder.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
  recorder.onstop=()=>{
    if(chunks.length){
      queue.push(new Blob(chunks,{type:recorder.mimeType||'audio/mp4'}));
      drain();
    }
  };
  recorder.start();
  segmentStart=performance.now();
}
async function startMeeting(){
  if(!ready) return toast('请先初始化免费模型');
  if(running) return stopMeeting();
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
    audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    await audioCtx.resume();
    analyser=audioCtx.createAnalyser();
    analyser.fftSize=1024;
    mediaSource=audioCtx.createMediaStreamSource(stream);
    mediaSource.connect(analyser);
    running=true;
    speechSeen=false;
    silenceAt=0;
    newRecorder();
    vadTimer=setInterval(vadTick,100);
    $('#talk').classList.add('listening');
    $('#talk').textContent='■ 结束会议翻译';
    $('#micStatus').textContent='🎙 会议监听中，直接连续讲话…';
  }catch(e){
    console.error(e);
    toast('麦克风启动失败：'+(e?.message||e));
  }
}
function vadTick(){
  if(!running||!analyser)return;
  const a=new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(a);
  let sum=0;
  for(const v of a){
    const x=(v-128)/128;
    sum += x*x;
  }
  const rms=Math.sqrt(sum/a.length);
  const now=performance.now();
  const delay=Number($('#silenceDelay').value||1300);
  if(rms>0.025){
    speechSeen=true;
    silenceAt=0;
  }else if(speechSeen){
    if(!silenceAt) silenceAt=now;
    if(now-silenceAt>delay && now-segmentStart>700){
      cutSegment();
      speechSeen=false;
      silenceAt=0;
    }
  }
  if(now-segmentStart>18000) cutSegment();
}
function cutSegment(){
  if(!recorder||recorder.state!=='recording') return;
  recorder.stop();
  setTimeout(()=>{
    if(running){
      try{ newRecorder(); }catch(e){ console.error(e); }
    }
  },140);
}
async function stopMeeting(){
  running=false;
  clearInterval(vadTimer);
  vadTimer=null;
  if(recorder?.state==='recording') recorder.stop();
  stream?.getTracks().forEach(t=>t.stop());
  try{ await audioCtx?.close(); }catch{}
  $('#talk').classList.remove('listening');
  $('#talk').textContent='🎙 开始连续会议翻译';
  $('#micStatus').textContent='🎙 会议已停止，剩余片段处理中…';
}
async function drain(){
  if(processing||!queue.length) return;
  processing=true;
  while(queue.length){
    const blob=queue.shift();
    try{
      $('#micStatus').textContent=`🧠 正在识别会议片段… 剩余 ${queue.length}`;
      const ab=await blob.arrayBuffer();
      const audio=await decodeAudio(ab);
      const out=await asr(audio,{chunk_length_s:18,stride_length_s:2});
      const text=(out?.text||'').trim();
      if(text) await translateAll(text);
    }catch(e){
      console.error(e);
      toast('本段识别失败，会议监听会继续');
    }
  }
  processing=false;
  $('#micStatus').textContent=running?'🎙 会议监听中，直接连续讲话…':'🎙 已停止';
}
async function decodeAudio(ab){
  const c=new (window.AudioContext||window.webkitAudioContext)();
  const decoded=await c.decodeAudioData(ab.slice(0));
  const off=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000);
  const src=off.createBufferSource();
  src.buffer=decoded;
  src.connect(off.destination);
  src.start();
  const rendered=await off.startRendering();
  await c.close();
  return rendered.getChannelData(0);
}

// 先绑定按钮；即使 AI CDN 出错，点击后也会给出明确报错。
$$('.scene').forEach(b=>b.onclick=()=>{
  $$('.scene').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  scene=b.dataset.scene;
  $('#sceneText').textContent='场景：'+b.textContent;
});
$('#loadModels').onclick=init;
$('#talk').onclick=startMeeting;
$('#translateText').onclick=()=>$('#textPanel').classList.toggle('hidden');
$('#runText').onclick=async()=>{
  const t=$('#manualText').value.trim();
  if(!t)return;
  if(!ready)return toast('请先初始化模型');
  try{await translateAll(t)}catch(e){toast('翻译失败：'+(e?.message||e))}
};
$('#clear').onclick=()=>{
  current={zh:'',es:'',en:'',source:''};
  ['zh','es','en'].forEach(l=>$(`#${l}`).textContent='');
  markSource('');
};
$('#copy').onclick=async()=>{
  const t=[...document.querySelectorAll('.turn')].map(x=>x.innerText).join('\n\n');
  if(!t)return toast('暂无记录');
  await navigator.clipboard.writeText(t);
  toast('已复制');
};
$('#clearHistory').onclick=()=>$('#history').innerHTML='<p class="muted">翻译完成后会保存在这里。</p>';

window.addEventListener('error', e=>{
  console.error(e.error||e.message);
  if(!ready){
    $('#engineStatus').textContent='❌ 页面脚本异常';
    $('#progressText').textContent=e.message||'刷新页面后重试';
  }
});
window.addEventListener('unhandledrejection', e=>{
  console.error(e.reason);
  if(!ready){
    $('#engineStatus').textContent='❌ AI加载异常';
    $('#progressText').textContent=e.reason?.message||String(e.reason||'未知错误');
  }
});

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js?v=041').then(reg=>reg.update().catch(()=>{})).catch(()=>{});
}
