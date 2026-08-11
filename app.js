// 矿山三语实时翻译助手 V0.5.2
// 单路径策略：一个页面生命周期内只加载一种 ASR 模型。
// normal: Whisper Base + WebGPU
// lite:   Whisper Tiny + WASM
// 如果 normal 失败，不在当前页面继续加载 Tiny，而是提示用户一键刷新进入 lite 模式。

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

env.allowLocalModels = false;
env.useBrowserCache = true;

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const NAMES={zh:'中文',es:'Español',en:'English'};
const qs=new URLSearchParams(location.search);
const forcedMode=qs.get('mode'); // lite | fast | null

let ready=false,running=false,stream=null,audioCtx=null,analyser=null,mediaSource=null,vadTimer=null;
let recorder=null,chunks=[],speechSeen=false,silenceAt=0,segmentStart=0;
let queue=[],processing=false,asr=null,pipes={},scene='drilling';
let current={zh:'',es:'',en:'',source:''};
let runtimeMode='detect', lastLang=null;
let noiseFloor=.008,calibrationSamples=[],calibrated=false;

const MODELS={
  zh_en:'Xenova/opus-mt-zh-en',
  en_zh:'Xenova/opus-mt-en-zh',
  es_en:'Xenova/opus-mt-es-en',
  en_es:'Xenova/opus-mt-en-es'
};

function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),3200)}
function setProgress(p,t){$('#bar').style.width=Math.max(0,Math.min(100,p))+'%';if(t)$('#progressText').textContent=t}
function detect(text){
  if(/[\u3400-\u9fff]/.test(text))return'zh';
  const s=' '+text.toLowerCase()+' ';
  const es=[' el ',' la ',' los ',' las ',' de ',' que ',' para ',' por ',' una ',' un ',' con ',' pero ',' porque ',' está ',' tenemos ',' sondaje ',' almacén ',' seguridad ',' mantenimiento ',' perforación ',' equipo '];
  const en=[' the ',' a ',' an ',' and ',' of ',' to ',' for ',' is ',' are ',' we ',' this ',' that ',' with ',' but ',' because ',' drill ',' warehouse ',' safety ',' maintenance ',' equipment '];
  const a=es.reduce((n,x)=>n+(s.includes(x)?1:0),0),b=en.reduce((n,x)=>n+(s.includes(x)?1:0),0);
  if(a===b)return/[áéíóúñ¿¡]/i.test(text)?'es':'en';
  return a>b?'es':'en';
}
function markSource(l){
  ['zh','es','en'].forEach(x=>{
    $(`#card-${x}`).classList.toggle('source',x===l);
    $(`#tag-${x}`).textContent=x===l?(x==='es'?'Original':'原文'):(x==='es'?'Traducción':'译文');
  });
  if(l)$('#micStatus').textContent=`🎙 当前识别：${NAMES[l]} · 连续监听中`;
}
function render(){
  ['zh','es','en'].forEach(l=>{
    const el=$(`#${l}`);
    if(current[l]){el.textContent=current[l];el.classList.remove('pending')}
  });
  markSource(current.source);
}
function renderImmediateSource(text,lang){
  current={zh:'',es:'',en:'',source:lang};
  current[lang]=text;
  ['zh','es','en'].forEach(l=>{
    const el=$(`#${l}`);
    if(l===lang){el.textContent=text;el.classList.remove('pending')}
    else{el.textContent='正在翻译…';el.classList.add('pending')}
  });
  markSource(lang);
}
function esc(s=''){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function addHistory(){
  const h=$('#history'); if(h.querySelector('.muted'))h.innerHTML='';
  const d=document.createElement('div'); d.className='turn';
  const tm=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  d.innerHTML=`<div class="meta">${tm} · 原文：${NAMES[current.source]}</div>
  <p><b>🇨🇳 中文</b>${esc(current.zh)}</p>
  <p><b>🇵🇪 Español</b>${esc(current.es)}</p>
  <p><b>🇺🇸 English</b>${esc(current.en)}</p>`;
  h.prepend(d);
}

function isLikelyInAppBrowser(){
  const ua=navigator.userAgent||'';
  return /MicroMessenger|FBAN|FBAV|Instagram|Line\//i.test(ua);
}

async function hasRealWebGPU(){
  try{
    if(!navigator.gpu)return false;
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter)return false;
    const dev=await adapter.requestDevice();
    dev.destroy?.();
    return true;
  }catch(e){
    console.warn('WebGPU probe failed',e);
    return false;
  }
}

function goMode(mode){
  const url=new URL(location.href);
  url.searchParams.set('mode',mode);
  location.replace(url.toString());
}

async function chooseMode(){
  if(forcedMode==='lite'){
    runtimeMode='lite';
    $('#runModeText').textContent='兼容模式 · Whisper Tiny / WASM';
    $('#gpuStatus').textContent='兼容模式：不使用 WebGPU';
    $('#modelStatus').textContent='识别模型：Whisper Tiny';
    $('#switchFast').classList.remove('hidden');
    return;
  }
  if(forcedMode==='fast'){
    runtimeMode='fast';
    $('#runModeText').textContent='高精度模式 · Whisper Base / WebGPU';
    $('#switchLite').classList.remove('hidden');
    return;
  }

  // In-app browsers are much less predictable. Choose lite immediately, no failed Base allocation first.
  if(isLikelyInAppBrowser()){
    runtimeMode='lite';
    $('#runModeText').textContent='内嵌浏览器 · 自动兼容模式';
    $('#gpuStatus').textContent='检测到内嵌浏览器，直接使用 WASM';
    $('#modelStatus').textContent='识别模型：Whisper Tiny';
    $('#switchFast').classList.remove('hidden');
    return;
  }

  const gpu=await hasRealWebGPU();
  if(gpu){
    runtimeMode='fast';
    $('#runModeText').textContent='高精度模式 · Whisper Base / WebGPU';
    $('#gpuStatus').textContent='⚡ WebGPU：已验证可用';
    $('#modelStatus').textContent='识别模型：Whisper Base';
    $('#switchLite').classList.remove('hidden');
  }else{
    runtimeMode='lite';
    $('#runModeText').textContent='兼容模式 · Whisper Tiny / WASM';
    $('#gpuStatus').textContent='WebGPU 不可用，直接进入兼容模式';
    $('#modelStatus').textContent='识别模型：Whisper Tiny';
    $('#switchFast').classList.remove('hidden');
  }
}

async function loadASR(){
  if(runtimeMode==='fast'){
    setProgress(8,'正在加载 Whisper Base · WebGPU…');
    try{
      asr=await pipeline('automatic-speech-recognition','onnx-community/whisper-base',{
        device:'webgpu',
        dtype:{encoder_model:'fp32',decoder_model_merged:'q4'},
        progress_callback:x=>{
          if(x?.status==='progress'){
            setProgress(8+Math.min(88,(x.progress||0)*.88),`Whisper Base：${Math.round(x.progress||0)}% · ${x.file||''}`);
          }
        }
      });
      return;
    }catch(e){
      console.error('Fast mode failed',e);
      // Critical: do NOT load any other model in this page.
      $('#engineStatus').textContent='❌ 高精度模式初始化失败';
      setProgress(0,'未继续加载第二个模型，以避免 iPhone 内存叠加。请点“切换兼容模式”，页面会刷新后重新加载。');
      $('#switchLite').classList.remove('hidden');
      throw new Error('高精度模式失败，请切换兼容模式');
    }
  }

  setProgress(10,'正在加载 Whisper Tiny · WASM 兼容模式…');
  asr=await pipeline('automatic-speech-recognition','onnx-community/whisper-tiny',{
    device:'wasm',
    dtype:'q8',
    progress_callback:x=>{
      if(x?.status==='progress'){
        setProgress(10+Math.min(86,(x.progress||0)*.86),`Whisper Tiny：${Math.round(x.progress||0)}% · ${x.file||''}`);
      }
    }
  });
}

async function init(){
  if(ready)return toast('模型已经初始化完成');
  const btn=$('#loadModels');btn.disabled=true;
  $('#engineStatus').textContent='正在初始化…';
  try{
    await loadASR();
    ready=true;
    setProgress(100,'✅ 语音识别模型已就绪；翻译模型第一次使用时再加载。');
    $('#engineStatus').textContent=`✅ 已就绪 · ${runtimeMode==='fast'?'高精度 WebGPU':'兼容 WASM'}`;
    $('#talk').disabled=false;btn.textContent='✅ 已初始化';
    toast('初始化成功');
  }catch(e){
    console.error(e);
    btn.disabled=false;
    if(runtimeMode==='lite'){
      $('#engineStatus').textContent='❌ 兼容模式初始化失败';
      setProgress(0,'兼容模式也失败。建议用 Safari 打开，并关闭其他占内存较大的应用后重试。');
    }
    toast(e.message||'初始化失败');
  }
}

async function getPipe(key){
  if(pipes[key])return pipes[key];
  const labels={zh_en:'中文→英语',en_zh:'英语→中文',es_en:'西语→英语',en_es:'英语→西语'};
  const label=labels[key];
  $('#engineStatus').textContent=`首次加载 ${label} 翻译模型…`;

  // Always WASM for translation: stable and independent from ASR GPU path
  const p=await pipeline('translation',MODELS[key],{
    device:'wasm',
    dtype:'q8',
    progress_callback:x=>{
      if(x?.status==='progress')setProgress(10+Math.min(88,(x.progress||0)*.88),`${label}：${Math.round(x.progress||0)}%`);
    }
  });
  pipes[key]=p;
  $('#engineStatus').textContent=`✅ 本地模型运行中 · ${runtimeMode==='fast'?'GPU识别':'兼容识别'}`;
  setProgress(100,`${label} 已缓存`);
  return p;
}

async function tr(key,text){
  const p=await getPipe(key);
  const r=await p(text,{max_new_tokens:160,num_beams:1});
  return r?.[0]?.translation_text||r?.[0]?.generated_text||'';
}

async function translateAll(text){
  const lang=detect(text);
  lastLang=lang;
  renderImmediateSource(text,lang);

  if(lang==='zh'){
    current.en=await tr('zh_en',text);render();
    current.es=await tr('en_es',current.en);render();
  }else if(lang==='es'){
    current.en=await tr('es_en',text);render();
    current.zh=await tr('en_zh',current.en);render();
  }else{
    current.en=text;
    await Promise.all([
      tr('en_zh',text).then(x=>{current.zh=x;render()}),
      tr('en_es',text).then(x=>{current.es=x;render()})
    ]);
  }
  addHistory();speakOut();
}

function speakOut(){
  const l=$('#speakLang').value;
  if(l==='off'||l===current.source||!current[l])return;
  try{
    speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(current[l]);
    u.lang=l==='zh'?'zh-CN':l==='es'?'es-PE':'en-US';
    speechSynthesis.speak(u);
  }catch{}
}

function newRecorder(){
  chunks=[];
  let opts={};
  if(MediaRecorder.isTypeSupported?.('audio/mp4'))opts={mimeType:'audio/mp4'};
  recorder=new MediaRecorder(stream,opts);
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
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
  if(!ready)return toast('请先初始化模型');
  if(running)return stopMeeting();
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    await audioCtx.resume();
    analyser=audioCtx.createAnalyser();analyser.fftSize=1024;
    mediaSource=audioCtx.createMediaStreamSource(stream);mediaSource.connect(analyser);
    running=true;speechSeen=false;silenceAt=0;calibrationSamples=[];calibrated=false;
    newRecorder();vadTimer=setInterval(vadTick,80);
    $('#talk').classList.add('listening');$('#talk').textContent='■ 结束连续翻译';
    $('#micStatus').textContent='🎙 正在校准环境噪声…';
  }catch(e){console.error(e);toast('麦克风启动失败：'+(e?.message||e))}
}

function vadTick(){
  if(!running||!analyser)return;
  const a=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(a);
  let sum=0;for(const v of a){const x=(v-128)/128;sum+=x*x}
  const rms=Math.sqrt(sum/a.length),now=performance.now();

  if(!calibrated && now-segmentStart<650){
    calibrationSamples.push(rms);
    noiseFloor=calibrationSamples.reduce((x,y)=>x+y,0)/calibrationSamples.length;
  }else if(!calibrated){
    calibrated=true;$('#micStatus').textContent='🎙 连续监听中…';
  }

  const threshold=Math.max(.018,noiseFloor*2.5);
  const delay=Number($('#silenceDelay').value||750);

  if(rms>threshold){
    speechSeen=true;silenceAt=0;
  }else if(speechSeen){
    if(!silenceAt)silenceAt=now;
    if(now-silenceAt>delay && now-segmentStart>850){
      cutSegment();speechSeen=false;silenceAt=0;
    }
  }
  if(now-segmentStart>8000)cutSegment();
}

function cutSegment(){
  if(!recorder||recorder.state!=='recording')return;
  recorder.stop();
  setTimeout(()=>{if(running)newRecorder()},100);
}

async function stopMeeting(){
  running=false;clearInterval(vadTimer);vadTimer=null;
  if(recorder?.state==='recording')recorder.stop();
  stream?.getTracks().forEach(t=>t.stop());
  try{await audioCtx?.close()}catch{}
  $('#talk').classList.remove('listening');
  $('#talk').textContent='🎙 开始连续翻译';
  $('#micStatus').textContent='🎙 已停止，剩余片段处理中…';
}

async function drain(){
  if(processing||!queue.length)return;
  processing=true;
  while(queue.length){
    const blob=queue.shift();
    try{
      $('#micStatus').textContent=`🧠 正在识别… 队列 ${queue.length}`;
      const ab=await blob.arrayBuffer();
      const audio=await decodeAudio(ab);

      const opts={
        task:'transcribe',
        chunk_length_s:8,
        stride_length_s:1,
        return_timestamps:false
      };

      // Small accuracy boost for consecutive same-language speech:
      // after first recognized segment, hint the next segment with previous language.
      // If the speaker changes, next result's script/words will update lastLang again.
      if(lastLang==='zh') opts.language='zh';
      else if(lastLang==='es') opts.language='es';
      else if(lastLang==='en') opts.language='en';

      const out=await asr(audio,opts);
      const text=(out?.text||'').trim();
      if(text)await translateAll(text);
    }catch(e){console.error(e);toast('本段识别失败，继续监听')}
  }
  processing=false;
  $('#micStatus').textContent=running?'🎙 连续监听中…':'🎙 已停止';
}

async function decodeAudio(ab){
  const c=new (window.AudioContext||window.webkitAudioContext)();
  const d=await c.decodeAudioData(ab.slice(0));
  const off=new OfflineAudioContext(1,Math.ceil(d.duration*16000),16000);
  const s=off.createBufferSource();s.buffer=d;s.connect(off.destination);s.start();
  const r=await off.startRendering();await c.close();
  return r.getChannelData(0);
}

$$('.scene').forEach(b=>b.onclick=()=>{
  $$('.scene').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');scene=b.dataset.scene;$('#sceneText').textContent='场景：'+b.textContent;
});
$('#loadModels').onclick=init;
$('#talk').onclick=startMeeting;
$('#switchLite').onclick=()=>goMode('lite');
$('#switchFast').onclick=()=>goMode('fast');
$('#translateText').onclick=()=>$('#textPanel').classList.toggle('hidden');
$('#runText').onclick=async()=>{
  const t=$('#manualText').value.trim();if(!t)return;
  if(!ready)return toast('请先初始化模型');
  try{await translateAll(t)}catch(e){console.error(e);toast('翻译失败：'+(e?.message||e))}
};
$('#clear').onclick=()=>{
  current={zh:'',es:'',en:'',source:''};
  ['zh','es','en'].forEach(l=>{$(`#${l}`).textContent='';$(`#${l}`).classList.remove('pending')});
  markSource('');
};
$('#copy').onclick=async()=>{
  const t=[...document.querySelectorAll('.turn')].map(x=>x.innerText).join('\n\n');
  if(!t)return toast('暂无记录');
  await navigator.clipboard.writeText(t);toast('已复制');
};
$('#clearHistory').onclick=()=>$('#history').innerHTML='<p class="muted">每个语音片段识别后会自动加入这里。</p>';

window.addEventListener('error',e=>{
  console.error(e.error||e.message);
  if(!ready){
    $('#engineStatus').textContent='❌ 页面异常';
    $('#progressText').textContent=e.message||'请刷新重试';
  }
});
window.addEventListener('unhandledrejection',e=>{
  console.error(e.reason);
  if(!ready){
    $('#engineStatus').textContent='❌ 模型异常';
    $('#progressText').textContent=e.reason?.message||String(e.reason||'未知错误');
  }
});

await chooseMode();

if('serviceWorker'in navigator){
  navigator.serviceWorker.register('./sw.js?v=052').then(r=>r.update().catch(()=>{})).catch(()=>{});
}
