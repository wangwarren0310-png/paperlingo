const $ = (s) => document.querySelector(s);
const els = {
  workspace: $('#workspace'), dropZone: $('#dropZone'), scroller: $('#documentScroller'), sample: $('#samplePaper'),
  pages: $('#pdfPages'), fileInput: $('#fileInput'), upload: $('#uploadBtn'), fileName: $('#fileName'),
  empty: $('#emptyState'), result: $('#resultState'), selected: $('#selectedText'), type: $('#resultType'),
  word: $('#wordResult'), passage: $('#passageResult'), translation: $('#translatedText'), note: $('#readingNote'),
  panel: $('#translationPane'), toast: $('#toast'),
  hand: $('#handBtn'), scrollCue: $('#scrollCue')
};
els.samples=[...document.querySelectorAll('.sample-paper')];

function cleanSelection(text){ return text.replace(/\s+/g,' ').trim(); }
function isWord(text){ return /^[A-Za-z][A-Za-z'-]{0,40}$/.test(text); }
function showToast(message){ els.toast.textContent=message; els.toast.classList.add('show'); clearTimeout(showToast.t); showToast.t=setTimeout(()=>els.toast.classList.remove('show'),1800); }

let activeTranslation=null;
let localTranslator=null;
const dictionaryCache=new Map();

function partOfSpeech(item){
  const source=`${item?.o||''} ${item?.t||''}`;
  const match=source.match(/(?:^|[\s/])(adj|adv|pron|prep|conj|art|num|n|v)[:.]/i);
  const labels={n:'noun',v:'verb',adj:'adjective',adv:'adverb',pron:'pronoun',prep:'preposition',conj:'conjunction',art:'article',num:'number'};
  return match?labels[match[1].toLowerCase()]||match[1]:'word';
}

async function lookupLocalWord(word){
  const letter=word[0]?.toLowerCase();
  if(!/^[a-z]$/.test(letter))return null;
  if(!dictionaryCache.has(letter)){
    const request=fetch(`dict/${letter}.json`).then(response=>{if(!response.ok)throw new Error('本地词典加载失败');return response.json()});
    dictionaryCache.set(letter,request);
  }
  const entries=await dictionaryCache.get(letter);
  return entries[word.toLowerCase()]||null;
}

async function getLocalTranslator(progress){
  if(localTranslator)return localTranslator;
  if(!('Translator' in self))throw new Error('当前浏览器尚未提供设备端句段翻译功能');
  const options={sourceLanguage:'en',targetLanguage:'zh'};
  const availability=await Translator.availability(options);
  if(availability==='unavailable')throw new Error('当前设备无法使用英中本地翻译模型');
  localTranslator=await Translator.create({...options,monitor(monitor){monitor.addEventListener('downloadprogress',event=>progress?.(Math.round(event.loaded*100)))}});
  return localTranslator;
}

async function translateOnDevice(text,progress){
  const translator=await getLocalTranslator(progress);
  if(typeof translator.translateStreaming==='function'&&text.length>4000){
    let result='';for await(const chunk of translator.translateStreaming(text))result+=chunk;return result;
  }
  return translator.translate(text);
}

async function showSelection(raw){
  const text=cleanSelection(raw); if(!text) return;
  els.empty.hidden=true; els.result.hidden=false; els.selected.textContent=text;
  const wordMode=isWord(text);
  els.type.textContent=wordMode?'词典':text.split(' ').length>18?'段落翻译':'句子翻译';
  els.word.hidden=!wordMode; els.passage.hidden=wordMode;
  if(wordMode){$('#wordTitle').textContent=text;$('#phonetic').textContent='查询中…';$('#partOfSpeech').textContent='';$('#definition').textContent='正在查询本地词典…';$('#contextMeaning').textContent='';$('#exampleSentence').textContent='';}
  else{els.translation.textContent='正在准备设备端翻译…';els.note.textContent='原始 PDF 和选中的文本都留在当前设备。';}
  els.panel.classList.add('open');
  const requestId={};activeTranslation=requestId;
  try{
    if(wordMode){
      const item=await lookupLocalWord(text);if(activeTranslation!==requestId)return;
      let translation=item?.t||'';if(!translation)translation=await translateOnDevice(text,percent=>{$('#definition').textContent=`正在下载英中语言包 ${percent}%`});
      $('#phonetic').textContent=item?.p?`/${item.p.replace(/^\/+|\/+$/g,'')}/`:'';$('#partOfSpeech').textContent=partOfSpeech(item);$('#definition').textContent=translation;$('#contextMeaning').textContent=item?.d?`英文释义：${item.d}`:'本地词典暂无英文释义。';$('#exampleSentence').textContent=item?.x?`词形：${item.x}`:'暂无词形信息';
    }else{
      const translation=await translateOnDevice(text,percent=>{els.translation.textContent=`首次使用，正在下载英中语言包 ${percent}%`});if(activeTranslation!==requestId)return;
      els.translation.textContent=translation;els.note.textContent='翻译在当前设备完成，文本和 PDF 均未上传服务器。';
    }
  }catch(error){
    if(activeTranslation!==requestId)return;
    const message=error.message||'翻译服务暂时不可用';
    if(wordMode){$('#phonetic').textContent='';$('#definition').textContent=message;$('#contextMeaning').textContent='请稍后重新选择这个单词。';}
    else{els.translation.textContent=message;els.note.textContent='中国大陆网络可能无法完成首次语言包下载；已下载的语言包后续可离线使用。';}
  }
}

document.addEventListener('mouseup',()=>{const selection=window.getSelection();if(selection&&!els.panel.contains(selection.anchorNode)){const text=selection.toString();if(cleanSelection(text))showSelection(text);}});
document.addEventListener('touchend',()=>setTimeout(()=>{ const text=window.getSelection()?.toString(); if(cleanSelection(text)) showSelection(text); },80),{passive:true});

els.upload.addEventListener('click',()=>els.fileInput.click());
els.fileInput.addEventListener('change',e=>e.target.files[0]&&openPdf(e.target.files[0]));
['dragenter','dragover'].forEach(ev=>els.dropZone.addEventListener(ev,e=>{e.preventDefault();els.dropZone.classList.add('dragging')}));
['dragleave','drop'].forEach(ev=>els.dropZone.addEventListener(ev,e=>{e.preventDefault();els.dropZone.classList.remove('dragging')}));
els.dropZone.addEventListener('drop',e=>{const file=[...e.dataTransfer.files].find(f=>f.type==='application/pdf'||f.name.toLowerCase().endsWith('.pdf'));file?openPdf(file):showToast('请选择 PDF 文件')});

let pdfDoc=null,scale=1.25;
async function openPdf(file){
  if(!window.pdfjsLib){showToast('PDF 解析组件尚未加载，请稍后重试');return}
  els.fileName.textContent=file.name; els.samples.forEach(page=>page.hidden=true); els.pages.hidden=false; els.pages.innerHTML='<div class="loading">正在打开 PDF…</div>';
  try{
    window.pdfjsLib.GlobalWorkerOptions.workerSrc='pdf.worker.min.js';
    pdfDoc=await window.pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    $('#pageTotal').textContent=pdfDoc.numPages; $('#pageNow').textContent='1'; await renderPdf(); showToast('PDF 已在本地打开');
  }catch(err){els.samples.forEach(page=>page.hidden=false);els.pages.hidden=true;showToast('无法读取这个 PDF，请尝试其他文件')}
}
async function renderPdf(){
  els.pages.innerHTML=''; const maxPages=pdfDoc.numPages;
  for(let n=1;n<=maxPages;n++){
    const page=await pdfDoc.getPage(n),viewport=page.getViewport({scale});
    const wrap=document.createElement('div');wrap.className='pdf-page';wrap.style.width=`${viewport.width}px`;wrap.style.height=`${viewport.height}px`;
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),ratio=Math.min(devicePixelRatio||1,2);canvas.width=viewport.width*ratio;canvas.height=viewport.height*ratio;canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;wrap.appendChild(canvas);
    const layer=document.createElement('div');layer.className='text-layer';layer.style.width=`${viewport.width}px`;layer.style.height=`${viewport.height}px`;wrap.appendChild(layer);els.pages.appendChild(wrap);
    await page.render({canvasContext:ctx,viewport,transform:ratio!==1?[ratio,0,0,ratio,0,0]:null}).promise;
    const content=await page.getTextContent(); await window.pdfjsLib.renderTextLayer({textContentSource:content,container:layer,viewport,textDivs:[]}).promise;
  }
}

$('#plusZoom').addEventListener('click',async()=>{scale=Math.min(2,scale+.15);$('#zoomLabel').textContent=Math.round(scale/1.25*100)+'%';pdfDoc?await renderPdf():els.samples.forEach(page=>page.style.transform=`scale(${scale/1.25})`)});
$('#minusZoom').addEventListener('click',async()=>{scale=Math.max(.8,scale-.15);$('#zoomLabel').textContent=Math.round(scale/1.25*100)+'%';pdfDoc?await renderPdf():els.samples.forEach(page=>page.style.transform=`scale(${scale/1.25})`)});
let scrollCueDismissed=false;
function dismissScrollCue(){
  if(scrollCueDismissed)return;
  scrollCueDismissed=true;
  els.scrollCue.classList.add('hidden');
}
function updateScrollState(){
  const remaining=els.scroller.scrollHeight-els.scroller.clientHeight-els.scroller.scrollTop;
  els.scrollCue.classList.toggle('hidden',scrollCueDismissed||remaining<36);
  const pages=pdfDoc?[...document.querySelectorAll('.pdf-page')]:els.samples;
  const toolbarBottom=$('.reader-toolbar').getBoundingClientRect().bottom;
  const idx=pages.findIndex(p=>p.getBoundingClientRect().bottom>toolbarBottom+60);$('#pageNow').textContent=Math.max(1,(idx<0?pages.length:idx+1));
}
els.scroller.addEventListener('scroll',()=>{if(els.scroller.scrollTop>6)dismissScrollCue();updateScrollState()},{passive:true});
els.scrollCue.addEventListener('click',()=>{dismissScrollCue();els.scroller.scrollBy({top:Math.max(320,els.scroller.clientHeight*.72),behavior:'smooth'})});
setTimeout(dismissScrollCue,4500);

let panning=false,panStart=null,spaceHeld=false;
function setHandMode(on,temporary=false){
  els.scroller.classList.toggle('hand-mode',on);
  if(!temporary) els.hand.classList.toggle('active',on);
  els.hand.setAttribute('aria-label',on?'关闭手掌拖动':'开启手掌拖动');
}
els.hand.addEventListener('click',()=>{const on=!els.hand.classList.contains('active');setHandMode(on);showToast(on?'手掌工具已开启 · 拖动页面浏览':'文本选择模式已开启')});
els.scroller.addEventListener('pointerdown',e=>{
  if(!els.scroller.classList.contains('hand-mode')||e.pointerType==='touch')return;
  panning=true;panStart={x:e.clientX,y:e.clientY,left:els.scroller.scrollLeft,top:els.scroller.scrollTop};
  els.scroller.classList.add('dragging-page');els.scroller.setPointerCapture(e.pointerId);e.preventDefault();
});
els.scroller.addEventListener('pointermove',e=>{if(!panning)return;els.scroller.scrollLeft=panStart.left-(e.clientX-panStart.x);els.scroller.scrollTop=panStart.top-(e.clientY-panStart.y);e.preventDefault()});
['pointerup','pointercancel'].forEach(ev=>els.scroller.addEventListener(ev,()=>{panning=false;els.scroller.classList.remove('dragging-page')}));
window.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.repeat){spaceHeld=true;setHandMode(true,true);e.preventDefault()}});
window.addEventListener('keyup',e=>{if(e.code==='Space'&&spaceHeld){spaceHeld=false;if(!els.hand.classList.contains('active'))setHandMode(false,true)}});

$('#clearBtn').addEventListener('click',()=>{els.result.hidden=true;els.empty.hidden=false;window.getSelection()?.removeAllRanges()});
$('#copyBtn').addEventListener('click',async()=>{const value=!els.word.hidden?`${$('#wordTitle').textContent}：${$('#definition').textContent}`:els.translation.textContent;await navigator.clipboard.writeText(value);showToast('已复制')});
$('#speakBtn').addEventListener('click',()=>{speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance($('#wordTitle').textContent))});
$('[data-select-example]').addEventListener('click',()=>showSelection('attention'));
$('#closePanel').addEventListener('click',()=>els.panel.classList.remove('open'));
$('#aboutBtn').addEventListener('click',()=>$('#aboutDialog').showModal());
$('#dialogClose').addEventListener('click',()=>$('#aboutDialog').close());

requestAnimationFrame(updateScrollState);

const style=document.createElement('style');style.textContent='.loading,.page-limit{padding:28px;text-align:center;color:#6f7a89;font-size:14px}.page-limit{background:#fff;border-radius:10px;margin:0 auto;width:max-content}';document.head.appendChild(style);

// Expose the same visible translation interaction to compatible browser agents.
if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();
  Promise.resolve(document.modelContext.registerTool({
    name:'translate_selection',title:'本地翻译选中的英文',
    description:'使用浏览器本地翻译和本地词典处理给定的英文单词、句子或段落，并在阅读器右侧显示结果。',
    inputSchema:{type:'object',properties:{text:{type:'string',minLength:1}},required:['text'],additionalProperties:false},
    annotations:{readOnlyHint:false,untrustedContentHint:true},
    async execute(input){if(!input||typeof input.text!=='string'||!cleanSelection(input.text))throw new Error('text 必须是非空英文文本');await showSelection(input.text);return{shown:true,mode:isWord(cleanSelection(input.text))?'dictionary':'translation'};}
  },{signal:lifecycle.signal})).catch(()=>{});
}
