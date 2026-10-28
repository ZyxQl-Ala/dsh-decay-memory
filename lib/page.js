// 设置页 HTML（host 直接吐给浏览器的纯前端，无构建步骤）
// 页面通过同源 fetch 读写 /decay-memory/api/*，由宿主插件的路由提供数据。

export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>会淡忘的记忆 · dsh-decay-memory</title>
<style>
  :root { color-scheme: dark; --bg:#0f1216; --card:#171c22; --line:#252c35; --text:#e6edf3; --dim:#8b98a5; --accent:#5b9dff; --warn:#f0a35e; --pin:#ffd166; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--dim); margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px; margin-bottom: 18px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(160px,1fr)); gap: 12px; }
  label { display:block; color: var(--dim); font-size: 12px; margin-bottom: 4px; }
  input[type=number], input[type=text] { width:100%; background:#0d1117; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; }
  button { background:#20262f; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 12px; cursor:pointer; font:inherit; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); color:#08121f; border-color: transparent; font-weight:600; }
  button.danger:hover { border-color:#e55353; color:#ff8b8b; }
  .row { border-top:1px solid var(--line); padding:12px 0; display:flex; gap:12px; align-items:flex-start; }
  .row:first-child { border-top:0; }
  .body { flex:1; min-width:0; }
  .text { word-break: break-word; }
  .meta { color: var(--dim); font-size: 12px; margin-top: 4px; display:flex; gap:10px; flex-wrap:wrap; }
  .bar { height:5px; background:#0d1117; border-radius:4px; overflow:hidden; margin-top:6px; }
  .bar > i { display:block; height:100%; background: linear-gradient(90deg,#5b9dff,#7ee0c0); }
  .faded { opacity:.65; }
  .pin { color: var(--pin); }
  .acts { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
  .empty { color: var(--dim); padding: 12px 0; }
  .toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); background:#20262f; border:1px solid var(--line); padding:10px 16px; border-radius:10px; opacity:0; transition:.2s; pointer-events:none; }
  .toast.show { opacity:1; }
  .hint { color: var(--dim); font-size:12px; margin-top:8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>会淡忘的记忆 <span class="pin">📌</span></h1>
  <div class="sub">被提起就点亮，不提就慢慢变短；📌 的永远记着。数据在本机：<code>$DSH_HOME/decay-memory/memory.json</code></div>

  <div class="card">
    <div class="grid">
      <div><label>半衰期（天）</label><input type="number" id="halfLifeDays" min="1" /></div>
      <div><label>开始渐淡（强度）</label><input type="number" id="fadeBelow" step="0.05" min="0.05" max="0.99" /></div>
      <div><label>真正删除（强度）</label><input type="number" id="dropBelow" step="0.01" min="0.005" max="0.5" /></div>
      <div><label>最多保留（条）</label><input type="number" id="maxEntries" min="4" max="200" /></div>
      <div><label>每轮注入（条）</label><input type="number" id="promptMaxEntries" min="1" max="50" /></div>
      <div><label>注入字数上限</label><input type="number" id="promptMaxChars" min="200" max="20000" /></div>
    </div>
    <div style="margin-top:14px; display:flex; gap:10px; align-items:center;">
      <button class="primary" id="save">保存设置</button>
      <button id="refresh">刷新</button>
      <span class="hint" id="status"></span>
    </div>
  </div>

  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
      <div><b>记忆列表</b> <span class="hint" id="count"></span></div>
      <div style="display:flex; gap:6px;">
        <input type="text" id="newText" placeholder="手动记一条…" style="width:220px" />
        <button id="add">记住</button>
      </div>
    </div>
    <div id="list"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let state = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

function fmtAgo(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  if (m < 1440) return Math.round(m / 60) + ' 小时前';
  return Math.round(m / 1440) + ' 天前';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, init) {
  const res = await fetch('/decay-memory/api' + path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok === false) throw new Error(j && j.error ? j.error : ('HTTP ' + res.status));
  return j;
}

function paint() {
  const c = state.config;
  for (const k of ['halfLifeDays', 'fadeBelow', 'dropBelow', 'maxEntries', 'promptMaxEntries', 'promptMaxChars']) {
    $(k).value = c[k];
  }
  $('count').textContent = '(' + state.entries.length + ' 条，' + state.pinnedCount + ' 条 📌；半衰期 ' + c.halfLifeDays + ' 天)';
  const list = $('list');
  if (!state.entries.length) {
    list.innerHTML = '<div class="empty">还没有记忆。让我记住点什么吧。</div>';
    return;
  }
  list.innerHTML = state.entries.map((e) => {
    const w = Math.round(e.weight * 100);
    const cls = e.faded ? 'faded' : '';
    return '<div class="row ' + cls + '">' +
      '<div class="body">' +
        '<div class="text">' + (e.pinned ? '<span class="pin">📌</span> ' : '') + esc(e.text) +
          (e.faded ? ' <span class="hint">（记忆渐淡）</span>' : '') + '</div>' +
        '<div class="meta"><span>' + esc(e.category) + '</span><span>' + fmtAgo(e.ts) + '</span><span>强度 ' + w + '%</span><span>提起 ' + e.n + ' 次</span><span>' + e.id + '</span></div>' +
        '<div class="bar"><i style="width:' + Math.max(2, w) + '%"></i></div>' +
      '</div>' +
      '<div class="acts">' +
        '<button data-op="touch" data-id="' + e.id + '">点亮</button>' +
        '<button data-op="pin" data-id="' + e.id + '">' + (e.pinned ? '取消 📌' : '📌 永久') + '</button>' +
        '<button class="danger" data-op="forget" data-id="' + e.id + '">删</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function load() {
  state = await api('/state');
  paint();
}

$('refresh').onclick = () => load().then(() => toast('已刷新')).catch((e) => toast(e.message));
$('save').onclick = async () => {
  try {
    const patch = {};
    for (const k of ['halfLifeDays', 'fadeBelow', 'dropBelow', 'maxEntries', 'promptMaxEntries', 'promptMaxChars']) {
      patch[k] = Number($(k).value);
    }
    state = await api('/config', { method: 'POST', body: JSON.stringify(patch) });
    paint();
    toast('设置已保存（下一轮生效）');
  } catch (e) { toast(e.message); }
};
$('add').onclick = async () => {
  const text = $('newText').value.trim();
  if (!text) return;
  try {
    state = await api('/action', { method: 'POST', body: JSON.stringify({ op: 'add', text }) });
    $('newText').value = '';
    paint();
    toast('记住了');
  } catch (e) { toast(e.message); }
};
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-op]');
  if (!btn) return;
  const op = btn.dataset.op;
  const id = btn.dataset.id;
  try {
    state = await api('/action', { method: 'POST', body: JSON.stringify({ op, id }) });
    paint();
    toast(op === 'forget' ? '已删除' : op === 'pin' ? '已更新 📌' : '已点亮');
  } catch (e) { toast(e.message); }
});
load().catch((e) => toast('读取失败：' + e.message));
</script>
</body>
</html>`;
}
