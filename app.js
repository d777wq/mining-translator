const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const NAMES={zh:'中文',es:'Español',en:'English'};
let worker=localStorage.getItem('mining_worker_url')||'';
let connected=false,running=false,stream=null,audioCtx=null,analyser=null,mediaSource=null,vadTimer=null;
let recorder=null,chunks=[],speechSeen=false,silenceAt=0,segmentStart=0,queue=[],processing=false;
let scene='drilling',current={zh:'',es:'',en:'',source:''};
let noiseFloor=.008,calibrationSamples=[],calibrated=false;

function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),3000)}
function baseUrl(v){return (v||'').trim().replace(/\/+$/,'')}
function markSource(l){
  ['zh','es','en'].forEach(x=>{
    $(`#card-${x}`).classList.toggle('source',x===l);
    $(`#tag-${x}`).textContent=x===l?(x==='es'?'Original':'原文'):(x==='es'?'Traducción':'译文');
  });
  if(l)$('#micStatus').textContent=`🎙 当前识别：${NAMES[l]} · 连续监听中`;
}
function render(){
  ['zh','es','en'].forEach(l=>{
    if(current[l]){$(`#${l}`).textContent=current[l];$(`#${l}`).classList.remove('pending')}
  });
  markSource(current.source);
}
function renderPending(){
  ['zh','es','en'].forEach(l=>{
    $(`#${l}`).textContent='正在识别 / 翻译…';
    $(`#${l}`).classList.add('pending');
  });
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

async function testWorker(url){
  url=baseUrl(url);
  if(!url)throw Error('请先填写 Worker 地址');
  const r=await fetch(url+'/health',{cache:'no-store'});
  if(!r.ok)throw Error('Worker 返回 '+r.status);
  const j=await r.json();
  if(!j.ok)throw Error('Worker 未就绪');
  return true;
}
async function connectWorker(){
  const url=baseUrl($('#workerUrl').value);
  $('#saveWorker').disabled=true;
  $('#engineStatus').textContent='正在测试免费 AI 服务…';
  try{
    await testWorker(url);
    worker=url;
    localStorage.setItem('mining_worker_url',worker);
    connected=true;
    $('.connect').classList.add('ok');
    $('#engineStatus').textContent='✅ 免费 AI 服务已连接';
    $('#engineHelp').textContent='无需初始化模型，可以直接开始连续翻译。';
    $('#talk').disabled=false;
    $('#configPanel').classList.add('hidden');
    toast('连接成功');
  }catch(e){
    connected=false;
    $('.connect').classList.remove('ok');
    $('#engineStatus').textContent='❌ 连接失败';
    $('#engineHelp').textContent=e.message;
    toast('连接失败：'+e.message);
  }finally{$('#saveWorker').disabled=false}
}
async function autoConnect(){
  if(!worker)return;
  $('#workerUrl').value=worker;
  try{
    await testWorker(worker);
    connected=true;
    $('.connect').classList.add('ok');
    $('#engineStatus').textContent='✅ 免费 AI 服务已连接';
    $('#engineHelp').textContent='无需初始化模型，可以直接开始连续翻译。';
    $('#talk').disabled=false;
  }catch{}
}

function newRecorder(){
  chunks=[];
  let opts={};
  if(MediaRecorder.isTypeSupported?.('audio/mp4'))opts={mimeType:'audio/mp4'};
  else if(MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus'))opts={mimeType:'audio/webm;codecs=opus'};
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
  if(!connected)return toast('请先配置免费 AI 服务');
  if(running)return stopMeeting();
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    await audioCtx.resume();
    analyser=audioCtx.createAnalyser();analyser.fftSize=1024;
    mediaSource=audioCtx.createMediaStreamSource(stream);mediaSource.connect(analyser);
    running=true;speechSeen=false;silenceAt=0;calibrationSamples=[];calibrated=false;
    newRecorder();vadTimer=setInterval(vadTick,80);
    $('#talk').classList.add('listening');
    $('#talk').textContent='■ 结束连续翻译';
    $('#micStatus').textContent='🎙 正在校准环境噪声…';
  }catch(e){toast('麦克风启动失败：'+e.message)}
}
function vadTick(){
  if(!running||!analyser)return;
  const a=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(a);
  let sum=0;for(const v of a){const x=(v-128)/128;sum+=x*x}
  const rms=Math.sqrt(sum/a.length),now=performance.now();
  if(!calibrated&&now-segmentStart<600){
    calibrationSamples.push(rms);
    noiseFloor=calibrationSamples.reduce((x,y)=>x+y,0)/calibrationSamples.length;
  }else if(!calibrated){
    calibrated=true;$('#micStatus').textContent='🎙 连续监听中…';
  }
  const threshold=Math.max(.018,noiseFloor*2.5);
  const delay=Number($('#silenceDelay').value||700);
  if(rms>threshold){speechSeen=true;silenceAt=0}
  else if(speechSeen){
    if(!silenceAt)silenceAt=now;
    if(now-silenceAt>delay&&now-segmentStart>750){
      cutSegment();speechSeen=false;silenceAt=0;
    }
  }
  if(now-segmentStart>7000)cutSegment();
}
function cutSegment(){
  if(!recorder||recorder.state!=='recording')return;
  recorder.stop();
  setTimeout(()=>{if(running)newRecorder()},80);
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

async function processBlob(blob){
  const r=await fetch(worker+'/process',{
    method:'POST',
    headers:{
      'Content-Type':blob.type||'audio/mp4',
      'X-Mining-Scene':scene
    },
    body:blob
  });
  let j;
  try{j=await r.json()}catch{throw Error('AI 服务返回异常')}
  if(!r.ok)throw Error(j?.error||('HTTP '+r.status));
  return j;
}
async function drain(){
  if(processing||!queue.length)return;
  processing=true;
  while(queue.length){
    const blob=queue.shift();
    try{
      $('#micStatus').textContent=`☁️ 正在快速识别翻译… 队列 ${queue.length}`;
      renderPending();
      const j=await processBlob(blob);
      if(j?.source&&j?.text){
        current={
          zh:j.zh||'',
          es:j.es||'',
          en:j.en||'',
          source:j.source
        };
        render();addHistory();speakOut();
      }
    }catch(e){
      console.error(e);
      toast('本段失败：'+e.message);
    }
  }
  processing=false;
  $('#micStatus').textContent=running?'🎙 连续监听中…':'🎙 已停止';
}

$$('.scene').forEach(b=>b.onclick=()=>{
  $$('.scene').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');scene=b.dataset.scene;$('#sceneText').textContent='场景：'+b.textContent;
});
$('#configBtn').onclick=()=>{$('#configPanel').classList.toggle('hidden');$('#workerUrl').value=worker};
$('#closeConfig').onclick=()=>$('#configPanel').classList.add('hidden');
$('#saveWorker').onclick=connectWorker;
$('#talk').onclick=startMeeting;
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
$('#clearHistory').onclick=()=>$('#history').innerHTML='<p class="muted">识别后的每个片段会自动保存在这里。</p>';

autoConnect();

if('serviceWorker'in navigator){
  navigator.serviceWorker.register('./sw.js?v=060').then(r=>r.update().catch(()=>{})).catch(()=>{});
}
