// 矿山三语实时翻译助手 V0.5
// 手机独立：WebGPU 优先 + Whisper Base；无 WebGPU 时自动降级。

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const NAMES={zh:'中文',es:'Español',en:'English'};
let pipeline=null, env=null;
let device='wasm', asrModel='onnx-community/whisper-base', asrDtype='q8';
let ready=false,running=false,stream=null,audioCtx=null,analyser=null,mediaSource=null,vadTimer=null;
let recorder=null,chunks=[],speechSeen=false,silenceAt=0,segmentStart=0;
let queue=[],processing=false,asr=null,pipes={},scene='drilling';
let current={zh:'',es:'',en:'',source:''};
let noiseFloor=0.008, calibrationSamples=[], calibrated=false;

const MODELS={
  zh_en:'Xenova/opus-mt-zh-en',
  en_zh:'Xenova/opus-mt-en-zh',
  es_en:'Xenova/opus-mt-es-en',
  en_es:'Xenova/opus-mt-en-es'
};

function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2800)}
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

async function detectDevice(){
  const hasGPU=!!navigator.gpu;
  if(hasGPU){
    device='webgpu';
    asrModel='onnx-community/whisper-base';
    asrDtype='q8';
    $('#gpuStatus').textContent='⚡ WebGPU：可用';
    $('#modelStatus').textContent='识别模型：Whisper Base（中文增强）';
  }else{
    device='wasm';
    asrModel='onnx-community/whisper-base';
    asrDtype='q8';
    $('#gpuStatus').textContent='⚠️ WebGPU：不可用，使用 CPU/WASM';
    $('#modelStatus').textContent='识别模型：Whisper Base（可能较慢）';
  }
}

async function loadEngine(){
  if(pipeline)return;
  setProgress(2,'正在加载 Transformers.js 4.2 高性能引擎…');
  const mod=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm');
  pipeline=mod.pipeline;env=mod.env;
  if(env){env.allowLocalModels=false;env.useBrowserCache=true}
}

async function init(){
  if(ready)return toast('模型已经初始化完成');
  const btn=$('#loadModels');btn.disabled=true;
  $('#engineStatus').textContent='正在启动手机增强模式…';
  try{
    await detectDevice();
    await loadEngine();
    setProgress(7,`正在加载 Whisper Base（${device==='webgpu'?'GPU':'CPU'}）…`);
    try{
      asr=await pipeline('automatic-speech-recognition',asrModel,{
        device,dtype:asrDtype,
        progress_callback:x=>{
          if(x?.status==='progress'){
            setProgress(7+Math.min(90,(x.progress||0)*.9),`Whisper Base：${Math.round(x.progress||0)}% · ${x.file||''}`);
          }
        }
      });
    }catch(firstErr){
      console.warn('Base model load failed',firstErr);
      // 极端兼容回退：仍保证手机能用
      asrModel='onnx-community/whisper-tiny';
      $('#modelStatus').textContent='识别模型：Whisper Tiny（兼容回退）';
      setProgress(10,'Base 加载失败，自动回退到 Tiny…');
      asr=await pipeline('automatic-speech-recognition',asrModel,{
        device,dtype:'q8',
        progress_callback:x=>{if(x?.status==='progress')setProgress(10+Math.min(88,(x.progress||0)*.88),`兼容模型：${Math.round(x.progress||0)}%`)}
      });
    }
    ready=true;
    setProgress(100,'✅ 识别模型已就绪；翻译模型按需加载并缓存。');
    $('#engineStatus').textContent=`✅ 手机增强模式已就绪 · ${device.toUpperCase()}`;
    $('#talk').disabled=false;btn.textContent='✅ 已初始化';
    toast('初始化完成');
  }catch(e){
    console.error(e);$('#engineStatus').textContent='❌ 初始化失败';setProgress(0,'错误：'+(e?.message||e));btn.disabled=false;toast('初始化失败');
  }
}

async function getPipe(key){
  if(pipes[key])return pipes[key];
  const labels={zh_en:'中文→英语',en_zh:'英语→中文',es_en:'西语→英语',en_es:'英语→西语'};
  const label=labels[key];
  $('#engineStatus').textContent=`首次加载 ${label} 翻译模型…`;
  let p;
  try{
    p=await pipeline('translation',MODELS[key],{
      device,dtype:'q8',
      progress_callback:x=>{if(x?.status==='progress')setProgress(10+Math.min(88,(x.progress||0)*.88),`${label}：${Math.round(x.progress||0)}%`)}
    });
  }catch(e){
    // 某些老 Marian ONNX 在特定 WebGPU 上可能不支持，单独回退 WASM
    console.warn(label,'webgpu failed, fallback wasm',e);
    p=await pipeline('translation',MODELS[key],{device:'wasm',dtype:'q8'});
  }
  pipes[key]=p;
  $('#engineStatus').textContent='✅ 本地模型运行中';
  setProgress(100,`${label} 已缓存`);
  return p;
}
async function tr(key,text){
  const p=await getPipe(key);
  const r=await p(text,{max_new_tokens:192,num_beams:1});
  return r?.[0]?.translation_text||r?.[0]?.generated_text||'';
}

async function translateAll(text){
  const lang=detect(text);
  renderImmediateSource(text,lang);
  if(lang==='zh'){
    // 第一阶段一出来立即显示英文，再补西语
    current.en=await tr('zh_en',text);render();
    current.es=await tr('en_es',current.en);render();
  }else if(lang==='es'){
    current.en=await tr('es_en',text);render();
    current.zh=await tr('en_zh',current.en);render();
  }else{
    current.en=text;
    const pZh=tr('en_zh',text).then(x=>{current.zh=x;render()});
    const pEs=tr('en_es',text).then(x=>{current.es=x;render()});
    await Promise.all([pZh,pEs]);
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
  let options={};
  if(MediaRecorder.isTypeSupported?.('audio/mp4'))options={mimeType:'audio/mp4'};
  recorder=new MediaRecorder(stream,options);
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
    $('#micStatus').textContent='🎙 正在校准环境噪声，请正常开始讲话…';
  }catch(e){console.error(e);toast('麦克风启动失败：'+(e?.message||e))}
}
function vadTick(){
  if(!running||!analyser)return;
  const a=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(a);
  let sum=0;for(const v of a){const x=(v-128)/128;sum+=x*x}
  const rms=Math.sqrt(sum/a.length),now=performance.now();
  if(!calibrated && now-segmentStart<700){
    calibrationSamples.push(rms);
    noiseFloor=calibrationSamples.reduce((x,y)=>x+y,0)/calibrationSamples.length;
  }else if(!calibrated){
    calibrated=true;
    $('#micStatus').textContent='🎙 连续监听中…';
  }
  const threshold=Math.max(0.018,noiseFloor*2.4);
  const delay=Number($('#silenceDelay').value||750);
  if(rms>threshold){
    speechSeen=true;silenceAt=0;
  }else if(speechSeen){
    if(!silenceAt)silenceAt=now;
    if(now-silenceAt>delay && now-segmentStart>850){
      cutSegment();speechSeen=false;silenceAt=0;
    }
  }
  // 小段优先，降低翻译等待
  if(now-segmentStart>8000)cutSegment();
}
function cutSegment(){
  if(!recorder||recorder.state!=='recording')return;
  recorder.stop();
  setTimeout(()=>{if(running)newRecorder()},90);
}
async function stopMeeting(){
  running=false;clearInterval(vadTimer);vadTimer=null;
  if(recorder?.state==='recording')recorder.stop();
  stream?.getTracks().forEach(t=>t.stop());
  try{await audioCtx?.close()}catch{}
  $('#talk').classList.remove('listening');$('#talk').textContent='🎙 开始连续翻译';
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
      // multilingual Whisper 自动检测中/西/英；task transcribe 防止自动翻成英语
      const out=await asr(audio,{
        task:'transcribe',
        chunk_length_s:8,
        stride_length_s:1,
        return_timestamps:false
      });
      const text=(out?.text||'').trim();
      if(text){
        // 原文一识别完成马上显示，翻译随后补齐
        await translateAll(text);
      }
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
  $$('.scene').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  scene=b.dataset.scene;$('#sceneText').textContent='场景：'+b.textContent;
});
$('#loadModels').onclick=init;
$('#talk').onclick=startMeeting;
$('#translateText').onclick=()=>$('#textPanel').classList.toggle('hidden');
$('#runText').onclick=async()=>{
  const t=$('#manualText').value.trim();if(!t)return;
  if(!ready)return toast('请先初始化模型');
  try{await translateAll(t)}catch(e){console.error(e);toast('翻译失败')}
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
  if(!ready){$('#engineStatus').textContent='❌ 页面异常';$('#progressText').textContent=e.message||'请刷新重试'}
});
window.addEventListener('unhandledrejection',e=>{
  console.error(e.reason);
  if(!ready){$('#engineStatus').textContent='❌ 模型异常';$('#progressText').textContent=e.reason?.message||String(e.reason||'未知错误')}
});

detectDevice();
if('serviceWorker'in navigator){
  navigator.serviceWorker.register('./sw.js?v=050').then(r=>r.update().catch(()=>{})).catch(()=>{});
}
