/** Native control document: no dependency on selected Web code or business DB. */
export function runtimeFallbackDocument(message){
  const detail=JSON.stringify(String(message).slice(0,64000)).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LoopWork 运行诊断</title><style>body{margin:0;background:#f7f7f5;color:#243042;font:15px system-ui}main{max-width:850px;margin:8vh auto;padding:32px;background:white;border:1px solid #dde3eb;border-radius:16px}h1{font-size:24px}p{line-height:1.8;color:#64748b}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#f3f5f8;border-radius:8px}button{padding:10px 16px;border:1px solid #ccd6e4;border-radius:8px;background:white;margin:6px 8px 6px 0;cursor:pointer}button:disabled{opacity:.5}</style>
<main><h1>控制入口仍在运行</h1><p>业务界面暂时无法加载。独立管理宿主会继续监督和调查；此页面不会把未知业务状态显示为已完成。</p>
<pre id="detail"></pre><button id="retry">重新加载界面</button><button id="stop">停止运行</button><button id="resume">恢复运行控制</button><pre id="state">正在读取管理状态…</pre></main>
<script>const bridge=window.loopworkLifecycle;document.getElementById('detail').textContent=${detail};
async function status(){try{document.getElementById('state').textContent=JSON.stringify(await bridge.status(),null,2)}catch{document.getElementById('state').textContent='管理状态暂时不可读，控制宿主不会因此启动本地业务监督。'}}
async function act(button,fn){button.disabled=true;try{const receipt=await fn();if(receipt)document.getElementById('detail').textContent=JSON.stringify(receipt,null,2)}catch(error){document.getElementById('detail').textContent=String(error)}finally{button.disabled=false;await status()}}
document.getElementById('retry').onclick=()=>act(document.getElementById('retry'),()=>bridge.retryUI());
document.getElementById('stop').onclick=()=>act(document.getElementById('stop'),()=>bridge.command({kind:'stop'}));
document.getElementById('resume').onclick=()=>act(document.getElementById('resume'),()=>bridge.command({kind:'resume-after-update'}));status();setInterval(status,10000);</script></html>`;
}
