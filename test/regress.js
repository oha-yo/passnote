// passnote の回帰テスト。iframe に passnote.html を開き、画面の操作（ボタン・入力）だけで決まった手順を行い、
// 画面の状態と保存データを記録して expected.json と比べる。
// passnote の中の変数や関数の名前には頼らない（中身を整理しても、同じ試験で確かめられるように）。
// 保存データは、この試験の中の復号の処理で開く（保存の形式が守られているかを、passnote の外から確かめるため）。
(async () => {
  const STORE_KEY = 'pass-note-vault-v1';
  const PW = 'test-master-123', PW2 = 'test-master-456', FIXTURE_PW = 'fixture-master-789';
  const frame = document.getElementById('app');
  const log = document.querySelector('.log'), result = document.querySelector('.result');
  const wait = ms => new Promise(f => setTimeout(f, ms));
  let W, D;
  const $ = id => D.getElementById(id);

  // ---- 暗号化（passnote と同じ形式：AES-GCM 256bit、鍵は PBKDF2-SHA256） ----
  const toB64 = bytes => btoa(String.fromCharCode(...bytes));
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function keyFor(pw, salt, iter) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function decryptBlob(blob, pw) {
    const key = await keyFor(pw, fromB64(blob.salt), blob.iter);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function encryptEntries(entries, pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(pw, salt, 600000);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify({ entries })));
    return { app: 'pass-note', v: 1, iter: 600000, salt: toB64(salt), iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
  }
  // 比べるときは、毎回変わる項目（id・作った日時・直した日時）を外し、項目の並びをそろえる
  const norm = entries => entries.map(e => Object.fromEntries(Object.entries(e).filter(([k]) => !['id', 'created', 'updated'].includes(k)).sort()));

  // ---- 試験用の「以前のデータ」（種類も順番もない、パスワード帳のころの形） ----
  if (location.search.includes('make-fixture')) {
    const blob = await encryptEntries([
      { id: 'f1', name: 'ダミーの社内Wiki', url: 'https://wiki.example.local/', user: 'dummy-user', pass: 'dummy-pass-F1', category: '社内', level: 'normal', memo: 'パスワード帳のころのデータ', created: '2026-09-29T00:00:00.000Z' },
      { id: 'f2', name: 'ダミーの銀行', url: 'https://bank.example.com/', user: 'dummy-bank', pass: 'dummy-pass-F2', category: 'お金', level: 'high', memo: '', created: '2026-09-29T00:00:00.000Z' },
      { id: 'f3', name: 'ダミーのルーター', url: '', user: 'admin', pass: 'dummy-pass-F3', category: '社内', level: 'low', memo: '型番 XX-1', created: '2026-09-29T00:00:00.000Z' },
    ], FIXTURE_PW);
    const r = await fetch('fixture-vault.json', { method: 'PUT', body: JSON.stringify(blob) });
    result.textContent = `fixture-vault.json を作りました（${r.status}）`;
    return;
  }

  // ---- 画面の操作 ----
  async function load() {
    frame.src = '../passnote.html?t=' + Date.now();
    await new Promise(f => frame.onload = f);
    W = frame.contentWindow; D = W.document;
    W.confirm = () => true;   // 削除・復元の確認は「はい」
    await wait(100);
  }
  async function until(cond, ms = 15000) {
    const t0 = Date.now();
    while (!cond()) { if (Date.now() - t0 > ms) throw new Error('待ちきれませんでした：' + cond); await wait(50); }
  }
  const shown = id => !$(id).classList.contains('hidden');
  const screen = () => ['setup', 'lock', 'app'].find(shown);
  const fire = (node, type) => node.dispatchEvent(new W.Event(type, { bubbles: true }));
  const setVal = (id, v) => { $(id).value = v; fire($(id), 'input'); };
  const text = node => node ? node.innerText.replace(/\s+/g, ' ').trim() : null;
  const toast = () => $('toast').textContent;
  // ダウンロードを横取りして、ファイル名と中身を返す（本当のファイルは作らない）
  async function captureDownload(action) {
    let got = null;
    const orig = W.HTMLAnchorElement.prototype.click;
    W.HTMLAnchorElement.prototype.click = function () { if (this.download) got = { name: this.download, href: this.href }; else orig.call(this); };
    try { await action(); await until(() => got, 5000); } finally { W.HTMLAnchorElement.prototype.click = orig; }
    return { name: got.name.replace(/\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD'), text: await (await W.fetch(got.href)).text() };
  }

  // 一覧の状態
  const rows = () => [...D.querySelectorAll('#list .item')].map(card => {
    const a = card.querySelector('.name a');
    const cmd = card.querySelector('.where button');
    return [text(card), (card.querySelector('.ti') || {}).title || '', a ? `${a.getAttribute('href')}|${a.title}` : '', cmd ? cmd.title : ''].filter(Boolean).join(' ¦ ');
  });
  const filters = () => [...D.querySelectorAll('#type-filter > *')].map(n =>
    text(n) + (n.getAttribute('aria-pressed') === 'true' ? '［選択中］' : '') + (n.querySelector('input') ? (n.querySelector('input').checked ? '［ON］' : '［OFF］') : ''));
  const view = () => ({ screen: screen(), filters: filters(), rows: rows(), empty: text(D.querySelector('#list .empty')) });
  const filterBtn = label => [...D.querySelectorAll('#type-filter button')].find(b => b.innerText.includes(label));
  const importantSwitch = () => D.querySelector('#type-filter input[type=checkbox]');
  const search = async q => { setVal('search', q); await wait(50); };
  async function stored(pw) {
    const raw = W.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw);
    return { keys: Object.keys(blob), app: blob.app, v: blob.v, iter: blob.iter, entries: norm((await decryptBlob(blob, pw)).entries) };
  }

  // 「＋ 追加」から1件登録する（f は入力欄の id → 値）
  async function add(type, f) {
    $('btn-add').click();
    const r = D.querySelector(`input[name="f-type"][value="${type}"]`);
    r.checked = true; fire(r, 'change');
    const form = { type, visible: [...D.querySelectorAll('#edit [data-for]')].filter(d => !d.classList.contains('hidden')).map(d => d.dataset.for), port: $('f-port').value, level: $('f-level').value };
    for (const [id, v] of Object.entries(f)) $(id).value = v;
    $('edit-form').requestSubmit();
    await until(() => !$('edit').open);
    return { form, toast: toast() };
  }
  // つまみを押して、別の行の上半分（前）か下半分（後ろ）まで動かして離す
  async function drag(fromName, toName, after) {
    const card = n => [...D.querySelectorAll('#list .item')].find(c => c.querySelector('.name').innerText === n);
    const g = card(fromName).querySelector('.grip').getBoundingClientRect();
    const r = card(toName).getBoundingClientRect();
    const x = r.left + r.width / 2, y = after ? r.bottom - 4 : r.top + 4;
    card(fromName).querySelector('.grip').dispatchEvent(new W.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: g.left + 4, clientY: g.top + 4 }));
    W.dispatchEvent(new W.PointerEvent('pointermove', { clientX: x, clientY: y }));
    const mark = card(toName).className;
    W.dispatchEvent(new W.PointerEvent('pointerup', { clientX: x, clientY: y }));
    await wait(400);
    return mark;
  }

  const out = {};
  try {
    // 0. 前のテストのデータを消して開く → 初回の画面
    localStorage.removeItem(STORE_KEY);
    await load();
    out.title = D.title;
    out.first = { screen: screen(), h1: text($('setup').querySelector('h1')) };

    // 1. マスターパスワードを決める（短い・食い違い → はじめる）
    $('setup-pw1').value = 'short'; $('setup-pw2').value = 'short'; $('setup-ok').click();
    out.setupShort = $('setup-error').textContent;
    $('setup-pw1').value = PW; $('setup-pw2').value = PW + 'x'; $('setup-ok').click();
    out.setupMismatch = $('setup-error').textContent;
    $('setup-pw2').value = PW; $('setup-ok').click();
    await until(() => screen() === 'app');
    out.empty = view();

    // 2. 3種類を登録する
    out.add = {};
    out.add.http = await add('http', { 'f-name': 'ダミーの管理画面', 'f-url': 'https://admin.example.com/login', 'f-user': 'admin', 'f-pass': 'dummy-pass-WEB', 'f-cat': 'Web サービス', 'f-memo': '二段階認証あり\n予備コードは金庫' });
    out.add.ssh = await add('ssh', { 'f-name': 'ダミーのWebサーバー', 'f-host': 'web01.example.local', 'f-user': 'deploy', 'f-pass': 'dummy-pass-SSH', 'f-cat': '社内サーバー' });
    out.add.ssh2 = await add('ssh', { 'f-name': 'ダミーの踏み台', 'f-host': 'bastion.example.local', 'f-port': '2222', 'f-user': "o'neil", 'f-pass': 'dummy-pass-BAS', 'f-cat': '社内サーバー', 'f-level': 'low' });
    out.add.db = await add('db', { 'f-name': 'ダミーの受注DB', 'f-host': '192.0.2.10', 'f-db': 'orders', 'f-user': 'app_user', 'f-pass': 'dummy-pass-DB', 'f-cat': '社内サーバー' });
    out.add.high = await add('http', { 'f-name': 'ダミーの銀行', 'f-url': 'https://bank.example.com/', 'f-user': 'dummy-bank', 'f-pass': 'dummy-pass-BANK', 'f-level': 'high' });
    out.add.nouser = await add('http', { 'f-name': 'ダミーのメモだけ', 'f-pass': 'dummy-pass-ONLY' });
    out.listed = view();

    // 3. 検索・種類の絞り込み・「重要」のスイッチ
    out.search = {};
    for (const q of ['example.local', 'ADMIN', 'orders', '社内', '金庫', '銀行', 'zzz']) { await search(q); out.search[q] = view(); }
    await search('');
    out.type = {};
    for (const t of ['Web', 'SSH', 'データベース']) { filterBtn(t).click(); out.type[t] = view(); }
    filterBtn('SSH').click(); await search('bastion'); out.typeAndSearch = view(); await search('');
    filterBtn('すべて').click();
    importantSwitch().click(); out.importantOn = view();
    await search('dummy-bank'); out.importantSearch = view(); await search('');
    out.add.whileImportant = await add('db', { 'f-name': 'ダミーの重要DB', 'f-host': 'db-main.example.local', 'f-db': 'core', 'f-user': 'dba', 'f-pass': 'dummy-pass-CORE' });
    out.importantAfterAdd = view();
    importantSwitch().click(); out.importantOff = view();
    filterBtn('データベース').click();
    out.add.whileType = await add('db', { 'f-name': 'ダミーの分析DB', 'f-host': 'dwh.example.local', 'f-db': 'dwh', 'f-user': 'analyst', 'f-pass': 'dummy-pass-DWH', 'f-level': 'high' });
    filterBtn('すべて').click();

    // 4. パスワードの表示（10 秒で隠れるが、ここではすぐ確かめる）
    const bankless = [...D.querySelectorAll('#list .item')].find(c => c.innerText.includes('ダミーのWebサーバー'));
    bankless.querySelector('.pass button').click();
    out.passShown = text(bankless.querySelector('.pass'));
    bankless.querySelector('.pass button').click();
    out.passHidden = text(bankless.querySelector('.pass'));

    // 5. ドラッグで並べ替え（前へ・後ろへ）
    out.drag = {};
    out.drag.mark1 = await drag('ダミーのメモだけ', 'ダミーの管理画面', false);
    out.drag.after1 = rows().map(r => r.split(' ')[0]);
    out.drag.mark2 = await drag('ダミーのWebサーバー', 'ダミーの受注DB', true);
    out.drag.after2 = rows().map(r => r.split(' ')[0]);
    out.add.afterDrag = await add('ssh', { 'f-name': 'ダミーの新サーバー', 'f-host': 'new01.example.local', 'f-user': 'ops', 'f-pass': 'dummy-pass-NEW' });
    out.drag.afterAdd = rows().map(r => r.split(' ')[0]);

    // 6. 編集（種類を変えると、使わない欄は空になる）・削除
    [...D.querySelectorAll('#list .item')].find(c => c.innerText.includes('ダミーの踏み台')).querySelector('button[title="編集"]').click();
    out.editOpen = { title: $('edit-title').textContent, type: D.querySelector('input[name="f-type"]:checked').value, host: $('f-host').value, port: $('f-port').value, user: $('f-user').value, level: $('f-level').value };
    const dbRadio = D.querySelector('input[name="f-type"][value="db"]'); dbRadio.checked = true; fire(dbRadio, 'change');
    out.editSwitchedPort = $('f-port').value;
    $('f-db').value = 'jump'; $('edit-form').requestSubmit(); await until(() => !$('edit').open);
    out.editToast = toast();
    [...D.querySelectorAll('#list .item')].find(c => c.innerText.includes('ダミーの新サーバー')).querySelector('button[title="編集"]').click();
    $('edit-delete').click(); await until(() => !$('edit').open);
    out.deleteToast = toast();
    out.afterEdit = view();

    // 7. 保存データ（この試験の中で復号して確かめる）
    out.stored = await stored(PW);

    // 8. バックアップを保存 → 中身は保存データと同じ形式で、同じマスターパスワードで開ける
    const backup = await captureDownload(async () => { $('btn-menu').click(); $('m-export').click(); });
    out.backup = { name: backup.name, entries: norm((await decryptBlob(JSON.parse(backup.text), PW)).entries).length, toast: toast() };
    $('menu').close();

    // 9. ロック → 違うパスワード → 正しいパスワード
    $('btn-lock').click();
    out.locked = { screen: screen(), h1: text($('lock').querySelector('h1')) };
    $('lock-pw').value = 'wrong-pass'; $('lock-ok').click();
    await until(() => $('lock-error').textContent && !$('lock-error').textContent.includes('確認'));
    out.wrongPw = $('lock-error').textContent;
    $('lock-pw').value = PW; $('lock-ok').click();
    await until(() => screen() === 'app');
    out.unlocked = view();   // 「重要」は OFF・種類は「すべて」に戻っている

    // 10. マスターパスワードの変更
    $('m-change').click();
    $('ask-pw1').value = PW2; $('ask-pw2').value = PW2; $('ask-form').requestSubmit();
    await until(() => toast().includes('変更'));
    out.changeToast = toast();
    out.changedOpensWithNew = (await stored(PW2)).entries.length;

    // 11. バックアップから復元（以前の形のデータ）→ 種類は Web として表示される
    const fixture = await (await fetch('fixture-vault.json', { cache: 'reload' })).text();
    const dt = new W.DataTransfer(); dt.items.add(new W.File([fixture], 'backup.json', { type: 'application/json' }));
    $('file-input').files = dt.files; fire($('file-input'), 'change');
    await until(() => $('ask').open);
    out.restoreAsk = $('ask-title').textContent;
    $('ask-pw1').value = FIXTURE_PW; $('ask-form').requestSubmit();
    await until(() => toast().includes('復元'));
    out.restoreToast = toast();
    out.restored = view();
    importantSwitch().click(); out.restoredImportant = view(); importantSwitch().click();

    // 12. 以前の形のデータが localStorage に入っていても、そのまま開ける
    W.localStorage.setItem(STORE_KEY, fixture);
    await load();
    out.fixtureScreen = screen();
    $('lock-pw').value = FIXTURE_PW; $('lock-ok').click();
    await until(() => screen() === 'app');
    out.fixtureOpened = view();

    // 13. マスターパスワードを忘れたときの初期化（消す前に、暗号化したまま保存する）
    $('btn-lock').click();
    $('lock-forgot').click();
    out.reset = { open: $('reset').open, disabled0: $('reset-ok').disabled };
    setVal('reset-confirm', 'しょきか'); out.reset.disabledWrong = $('reset-ok').disabled;
    setVal('reset-confirm', '初期化する'); out.reset.disabledRight = $('reset-ok').disabled;
    const before = W.localStorage.getItem(STORE_KEY);
    const saved = await captureDownload(async () => { $('reset-form').requestSubmit(); });
    out.reset.file = saved.name;
    out.reset.sameAsStored = saved.text === before;
    out.reset.storageAfter = W.localStorage.getItem(STORE_KEY);
    out.reset.screen = screen();
    out.reset.toast = toast();
  } catch (e) {
    out.error = String(e && e.stack || e);
  } finally {
    if (W) W.localStorage.removeItem(STORE_KEY);   // テストのデータを残さない
  }

  const json = JSON.stringify(out, null, 2);
  if (location.search.includes('update')) {
    result.textContent = out.error ? 'エラーで止まりました（下を見てください）' : '記録しました。下の JSON を test/expected.json に保存してください。';
    log.textContent = json;
    window.REGRESS = { out };
    return;
  }
  let expected;
  try { expected = await (await fetch('expected.json', { cache: 'reload' })).json(); }
  catch (e) { result.textContent = 'expected.json を読めませんでした。?update を付けて開き、作ってください。'; result.className = 'result ng'; window.REGRESS = { out }; return; }
  const diffs = [];
  const walk = (a, b, path) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object') { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path + '.' + k); }
    else diffs.push(`${path}\n  期待：${JSON.stringify(a)}\n  結果：${JSON.stringify(b)}`);
  };
  walk(expected, out, '');
  result.textContent = diffs.length ? `NG：${diffs.length} か所が違います` : `OK：${Object.keys(expected).length} 項目すべて同じです`;
  result.className = 'result ' + (diffs.length ? 'ng' : 'ok');
  log.textContent = diffs.join('\n\n') || json;
  window.REGRESS = { out, diffs };
})();
