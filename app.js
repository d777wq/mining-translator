// 矿山三语实时翻译助手 V0.5.1
// 稳定策略：真实检测 WebGPU adapter。
// WebGPU: Whisper Base + per-module dtype (encoder fp32, decoder q4)
// fallback 1: WASM Whisper Base q8
// fallback 2: WASM Whisper Tiny q8

import {
  pipeline,
  env
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

env.allowLocalModels = false;
env.useBrowserCache = true;

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const NAMES={zh:'中文',es:'Español',en:'English'};

let ready=false,running=false,stream=null,audioCtx=null,analyser=null,mediaSource=null,vadTimer=null;
let recorder=null,chunks=[],speechSeen=false,silenceAt=0,segmentStart=0;
let queue=[],processing=false,asr=null,pipes={},scene='drilling';
let current={zh:'',es:'',en:'',source:''};
let computeMode='wasm', asrModel='', noiseFloor=.008, calibrationSamples=[], calibrated=false;

const MODELS={
  zh_en:'Xenova/opus-mt-zh-en',
  en_zh:'Xenova/opus-mt-en-zh',
  es_en:'Xenova/opus-mt-es-en',
  en_es:'Xenova/opus-mt-en-es'
};

function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),3000)}
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
  const h=$('#history');if(h.querySelector('.muted'))h.innerHTML='';
  const d=document.createElement('div');d.className='turn';
  const tm=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  d.innerHTML=`<div class="meta">${tm} · 原文：${NAMES[current.source]}</div>
  <p><b>🇨🇳 中文</b>${esc(current.zh)}</p>
  <p><b>🇵🇪 Español</b>${esc(current.es)}</p>
  <p><b>🇺🇸 English</b>${esc(current.en)}</p>`;
  h.prepend(d);
}

async function hasUsableWebGPU(){
  try{
    if(!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter) return false;
    // requestDevice catches browsers that expose navigator.gpu but cannot actually create a device
    const dev = await adapter.requestDevice();
    dev.destroy?.();
    return true;
  }catch(e){
    console.warn('WebGPU probe failed:', e);
    return false;
  }
}

async function loadASR(){
  const webgpuOK = await hasUsableWebGPU();
  if(webgpuOK){
    $('#gpuStatus').textContent='⚡ WebGPU：已验证可用';
    $('#modelStatus').textContent='识别模型：Whisper Base（GPU）';
    setProgress(8,'正在加载 Whisper Base · WebGPU 稳定配置…');
    try{
      asrModel='onnx-community/whisper-base';
      asr=await pipeline('automatic-speech-recognition',asrModel,{
        device:'webgpu',
        dtype:{
          encoder_model:'fp32',
          decoder_model_merged:'q4'
        },
        progress_callback:x=>{
          if(x?.status==='progress'){
            setProgress(8+Math.min(88,(x.progress||0)*.88),`Whisper Base GPU：${Math.round(x.progress||0)}% · ${x.file||''}`);
          }
        }
      });
      computeMode='webgpu';
      return;
    }catch(e){
      console.warn('Whisper Base WebGPU failed; fallback to WASM',e);
      $('#gpuStatus').textContent='⚠️ WebGPU模型加载失败，自动切 CPU/WASM';
      setProgress(12,'GPU 模型加载失败，正在自动切换 CPU/WASM Base…');
    }
  }else{
    $('#gpuStatus').textContent='ℹ️ WebGPU 不可用，自动使用 CPU/WASM';
  }

  // Base on WASM q8
  try{
    asrModel='onnx-community/whisper-base';
    $('#modelStatus').textContent='识别模型：Whisper Base（CPU/WASM）';
    asr=await pipeline('automatic-speech-recognition',asrModel,{
      device:'wasm',
      dtype:'q8',
      progress_callback:x=>{
        if(x?.status==='progress'){
          setProgress(12+Math.min(84,(x.progress||0)*.84),`Whisper Base CPU：${Math.round(x.progress||0)}% · ${x.file||''}`);
        }
      }
    });
    computeMode='wasm';
    return;
  }catch(e){
    console.warn('Whisper Base WASM failed; fallback Tiny',e);
    setProgress(18,'Base 仍无法加载，正在切换兼容 Tiny…');
  }

  // final fallback
  asrModel='onnx-community/whisper-tiny';
  $('#modelStatus').textContent='识别模型：Whisper Tiny（兼容模式）';
  asr=await pipeline('automatic-speech-recognition',asrModel,{
    device:'wasm',
    dtype:'q8',
    progress_callback:x=>{
      if(x?.status==='progress'){
        setProgress(18+Math.min(78,(x.progress||0)*.78),`Whisper Tiny：${Math.round(x.progress||0)}%`);
      }
    }
  });
  computeMode='wasm';
}

async function init(){
  if(ready)return toast('模型已经初始化完成');
  const btn=$('#loadModels');btn.disabled=true;
  $('#engineStatus').textContent='正在启动 V0.5.1 稳定模式…';
  try{
    await loadASR();
    ready=true;
    setProgress(100,'✅ 语音识别模型已就绪；翻译模型第一次使用时再缓存。');
    $('#engineStatus').textContent=`✅ 已就绪 · ${computeMode==='webgpu'?'WebGPU':'CPU/WASM'}`;
    $('#talk').disabled=false;
    btn.textContent='✅ 已初始化';
    toast('初始化成功');
  }catch(e){
    console.error(e);
    $('#engineStatus').textContent='❌ 初始化失败';
    setProgress(0,'错误：'+(e?.message||e));
    btn.disabled=false;
    toast('初始化失败，请截图错误文字给我');
  }
}

async function getPipe(key){
  if(pipes[key])return pipes[key];
  const labels={zh_en:'中文→英语',en_zh:'英语→中文',es_en:'西语→英语',en_es:'英语→西语'};
  const label=labels[key];
  $('#engineStatus').textContent=`首次加载 ${label} 翻译模型…`;

  // 翻译模型优先用 WASM：小 Marian 模型在手机上更稳，避免再触发 WebGPU 兼容问题
  const p=await pipeline('translation',MODELS[key],{
    device:'wasm',
    dtype:'q8',
    progress_callback:x=>{
      if(x?.status==='progress')setProgress(10+Math.min(88,(x.progress||0)*.88),`${label}：${Math.round(x.progress||0)}%`);
    }
  });
  pipes[key]=p;
  $('#engineStatus').textContent=`✅ 本地模型运行中 · ${computeMode==='webgpu'?'GPU识别':'CPU识别'}`;
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
  }catch(e){
    console.error(e);toast('麦克风启动失败：'+(e?.message||e));
  }
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
      const out=await asr(audio,{
        task:'transcribe',
        chunk_length_s:8,
        stride_length_s:1,
        return_timestamps:false
      });
      const text=(out?.text||'').trim();
      if(text)await translateAll(text);
    }catch(e){
      console.error(e);toast('本段识别失败，继续监听');
    }
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
  b.classList.add('active');
  scene=b.dataset.scene;
  $('#sceneText').textContent='场景：'+b.textContent;
});
$('#loadModels').onclick=init;
$('#talk').onclick=startMeeting;
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

if('serviceWorker'in navigator){
  navigator.serviceWorker.register('./sw.js?v=051').then(r=>r.update().catch(()=>{})).catch(()=>{});
}
