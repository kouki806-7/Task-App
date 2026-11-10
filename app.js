/**
 * Daily Flow (v3 — 最小構成)
 *
 * できること:
 *   - 今日のタスク: 1行で追加（「60分」「明日」を書ける）、完了、削除、未完了は翌日へ繰り越し
 *   - 毎日のタスク: 専用の画面で登録・編集・削除。毎朝5時に今日のタスクへ自動で入る
 *   - タイマー: 各タスクの ▶ で計測、一時停止、完了で実績を記録
 *   - 予定にない作業: 名前を書いて「今すぐ計測」
 *   - Google ToDo: 未完了タスクを取り込む（読むだけ）
 *   - Google カレンダー: 今日の予定を表示（読むだけ・タスクにはしない）
 *   - 23時以降: その日の実績を専用カレンダー「Daily Flow 実績」に「[実績] 名前」で登録
 *
 * データ:
 *   以前の版と同じ localStorage キー（daily_flow_data）を使い、知らない項目も消さずに残す。
 *   以前の版の全機能は Git の履歴（コミット eb23818 以前）から戻せる。
 */
(function () {
    'use strict';

    // ════════════════════════════════════════════════════════
    // 定数・ユーティリティ
    // ════════════════════════════════════════════════════════
    const STORAGE_KEY = 'daily_flow_data';
    const TOKEN_KEY = 'daily_flow_gtoken';
    const DAY_BOUNDARY_HOUR = 5;   // 0〜5時は前日扱い
    const PUSH_HOUR = 23;          // この時刻を過ぎたら実績をカレンダーへ
    const REC_CAL_NAME = 'Daily Flow 実績';
    const REC_PREFIX = '[実績] ';
    const DEFAULT_CLIENT_ID = '402677092902-bceev6me91ekc1so00g2h96doqd1ripr.apps.googleusercontent.com';
    const SCOPE = [
        'https://www.googleapis.com/auth/calendar.readonly',     // 予定を読む
        'https://www.googleapis.com/auth/calendar.app.created',  // 専用カレンダーの作成・書き込み
        'https://www.googleapis.com/auth/tasks.readonly'         // Google ToDo を読む
    ].join(' ');
    const CAL_API = 'https://www.googleapis.com/calendar/v3';
    const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

    const $ = id => document.getElementById(id);
    const pad = n => String(n).padStart(2, '0');
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
    const genId = () => Math.random().toString(36).substring(2, 9);

    function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
    function today() {
        const d = new Date();
        if (d.getHours() < DAY_BOUNDARY_HOUR) d.setDate(d.getDate() - 1);
        return ymd(d);
    }
    function addDays(dateStr, n) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return ymd(new Date(y, m - 1, d + n));
    }
    function hm(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
    function fmtTimer(sec) {
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    function fmtMins(sec) {
        const m = Math.round(sec / 60);
        return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}` : `${m}分`;
    }

    let toastTimer = null;
    function toast(msg) {
        const el = $('toast');
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
    }

    // ════════════════════════════════════════════════════════
    // データ
    // ════════════════════════════════════════════════════════
    let state = {};

    function load() {
        try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
        catch (e) { state = {}; }
        // 以前の版の項目（統計・ゴールなど）はそのまま残し、使う項目だけ整える
        if (!Array.isArray(state.tasks)) state.tasks = [];
        if (!Array.isArray(state.routines)) state.routines = [];
        if (!Array.isArray(state.schedules)) state.schedules = [];
        if (!Array.isArray(state.pausedTimers)) state.pausedTimers = [];
        if (!state.settings) state.settings = {};
        if (!state.settings.clientId) state.settings.clientId = DEFAULT_CLIENT_ID;
        if (!state.settings.gsync) state.settings.gsync = {};
        if (!Array.isArray(state.settings.gsync.doneGtaskIds)) state.settings.gsync.doneGtaskIds = [];
        if (!state.timer) state.timer = {};
        const t = state.timer;
        if (t.taskId === undefined) t.taskId = null;
        if (!t.accumulatedSeconds) t.accumulatedSeconds = 0;
        if (!t.isRunning) { t.isRunning = false; t.startTime = null; }
        state.tasks.forEach(task => { if (!task.date) task.date = today(); });
        if (!Array.isArray(state.settings.deletedRoutineIds)) state.settings.deletedRoutineIds = [];
        // 一度だけ: 以前の版で登録された毎日のタスクを片付ける（新しい登録画面で作り直す）
        let migrated = false;
        if (!state.settings.routineResetAt) {
            state.settings.routineResetAt = Date.now();
            migrated = true;
        }
        cleanRoutines();
        cleanPaused();
        if (!rollover() && migrated) save(true);
    }

    // system=true は日付の切り替えなど自動の処理。利用者の操作ではないので「未送信の変更」扱いにしない
    function save(system = false) {
        // クラウドに送る前の変更があることを覚えておく（送る前に閉じても、次回は手元を優先する）
        if (!system && state.settings && state.settings.firebaseConfig) state.cloudDirty = true;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
        catch (e) { toast('保存に失敗しました: ' + e.message); }
        scheduleCloudSave();
    }

    // 日付が変わったら: 完了済みを片付け、未完了は残し、毎日のタスクを今日の分だけ作る
    function rollover() {
        const d = today();
        if (state.lastDate === d) return false;
        state.tasks = state.tasks.filter(t => t.id === state.timer.taskId ||
            (t.isRoutine ? t.date === d : (!t.completed || t.date >= d)));
        ensureRoutineTasksToday();
        state.lastDate = d;
        save(true);
        return true;
    }

    // ── 毎日のタスク ───────────────────────────────────────
    // 登録（state.routines）を元に、今日の分のタスクがなければ作る。何度呼んでも重複しない
    function ensureRoutineTasksToday() {
        const d = today();
        state.routines.forEach(r => {
            if (r.skipDate === d) return; // 今日はスキップ
            if (state.tasks.some(t => t.isRoutine && t.routineId === r.id && t.date === d)) return;
            state.tasks.push({ id: genId(), routineId: r.id, text: r.text, duration: r.duration || 0,
                tag: 'タスク', date: d, completed: false, isRoutine: true });
        });
    }

    // 古い登録（作り直す前のもの）と削除済みの登録を外し、対応する今日のタスクも外す
    function cleanRoutines() {
        const resetAt = state.settings.routineResetAt || 0;
        const deleted = new Set(state.settings.deletedRoutineIds || []);
        state.routines = state.routines.filter((r, i, arr) =>
            r && r.createdAt && r.createdAt >= resetAt && !deleted.has(r.id) && arr.findIndex(x => x.id === r.id) === i);
        const ids = new Set(state.routines.map(r => r.id));
        const removed = state.tasks.filter(t => t.isRoutine && !ids.has(t.routineId)).map(t => t.id);
        if (!removed.length) return;
        if (removed.includes(state.timer.taskId)) resetTimer();
        state.pausedTimers = state.pausedTimers.filter(p => !removed.includes(p.taskId));
        state.tasks = state.tasks.filter(t => !removed.includes(t.id));
    }

    // ── 毎日のタスクの一括管理 ─────────────────────────────
    // 画面を開いた時点の登録を下書き（rDraft）にコピーし、追加・編集・削除・並べ替えは下書きに対して行う。
    // 「変更を保存」でまとめて反映する。
    let rDraft = null;        // [{ id, text, duration, createdAt, skipDate, isNew }]
    let rBaseIds = [];        // 開いた時点にあった登録のID（他の端末での追加分を消さないために使う）
    let rSelected = new Set();

    function startRoutineEdit() {
        rDraft = state.routines.map(r => ({ ...r }));
        rBaseIds = state.routines.map(r => r.id);
        rSelected = new Set();
    }

    function routineChanges() {
        if (!rDraft) return { added: 0, edited: 0, removed: 0, reordered: false, total: 0 };
        const cur = new Map(state.routines.map(r => [r.id, r]));
        const added = rDraft.filter(d => d.isNew).length;
        const removed = rBaseIds.filter(id => cur.has(id) && !rDraft.some(d => d.id === id)).length;
        const edited = rDraft.filter(d => {
            const o = !d.isNew && cur.get(d.id);
            return o && (o.text !== d.text.trim() || (o.duration || 0) !== (d.duration || 0));
        }).length;
        const keptOrder = rDraft.filter(d => !d.isNew && cur.has(d.id)).map(d => d.id);
        const origOrder = state.routines.map(r => r.id).filter(id => keptOrder.includes(id));
        const reordered = keptOrder.join() !== origOrder.join();
        return { added, edited, removed, reordered, total: added + edited + removed + (reordered ? 1 : 0) };
    }

    function parseRoutineLine(line) {
        const p = parseInput(line);
        return { text: p.text.trim(), duration: p.duration || 0 };
    }

    // 複数行をまとめて下書きに追加（1行1件。「単語帳 30分」のように時間も書ける）
    function draftAddLines(text) {
        let added = 0, dup = 0;
        text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
            const { text: name, duration } = parseRoutineLine(line);
            if (!name) return;
            if (rDraft.some(d => d.text.trim() === name)) { dup++; return; }
            rDraft.push({ id: genId(), text: name, duration, isNew: true });
            added++;
        });
        return { added, dup };
    }

    function saveRoutineEdits() {
        if (!rDraft) return;
        if (rDraft.some(d => !d.isNew && !d.text.trim())) { toast('名前が空の項目があります'); return false; }
        const ch = routineChanges();
        const cur = new Map(state.routines.map(r => [r.id, r]));
        const now = Date.now();
        // 削除: 開いた時点にあって下書きから消えたもの
        const removedIds = rBaseIds.filter(id => cur.has(id) && !rDraft.some(d => d.id === id));
        const del = state.settings.deletedRoutineIds;
        removedIds.forEach(id => { if (!del.includes(id)) del.push(id); });
        if (del.length > 500) del.splice(0, del.length - 500);
        // 下書きの順に並べ、他の端末で編集中に追加された分は後ろに残す
        const next = rDraft.filter(d => d.text.trim()).map(d => {
            const o = cur.get(d.id);
            return { id: d.id, text: d.text.trim(), duration: d.duration || 0,
                createdAt: (o && o.createdAt) || d.createdAt || now, skipDate: (o ? o.skipDate : d.skipDate) || null };
        });
        state.routines.forEach(r => {
            if (!rBaseIds.includes(r.id) && !next.some(n => n.id === r.id)) next.push(r);
        });
        state.routines = next;
        // 今日のまだ終わっていない分に名前・時間の変更を反映
        state.tasks.forEach(t => {
            if (!t.isRoutine || t.completed || t.date !== today()) return;
            const r = state.routines.find(x => x.id === t.routineId);
            if (r) { t.text = r.text; t.duration = r.duration || 0; }
        });
        cleanRoutines();
        ensureRoutineTasksToday();
        // 今日のタスクの並びも登録順に合わせる
        const order = new Map(state.routines.map((r, i) => [r.id, i]));
        const rt = state.tasks.filter(t => t.isRoutine && t.date === today()).sort((a, b) => order.get(a.routineId) - order.get(b.routineId));
        let k = 0;
        state.tasks = state.tasks.map(t => (t.isRoutine && t.date === today()) ? rt[k++] : t);
        save(); render();
        startRoutineEdit(); renderRoutines();
        const parts = [];
        if (ch.added) parts.push(`追加 ${ch.added}`);
        if (ch.edited) parts.push(`変更 ${ch.edited}`);
        if (ch.removed) parts.push(`削除 ${ch.removed}`);
        if (ch.reordered) parts.push('並べ替え');
        toast(parts.length ? `保存しました（${parts.join('・')}）` : '変更はありません');
        return true;
    }

    function setRoutineSkip(id, skip) {
        const r = state.routines.find(x => x.id === id);
        if (!r) return;
        r.skipDate = skip ? today() : null;
        if (skip) {
            const t = state.tasks.find(x => x.isRoutine && x.routineId === id && x.date === today() && !x.completed);
            if (t) {
                if (state.timer.taskId === t.id) resetTimer();
                state.tasks = state.tasks.filter(x => x.id !== t.id);
            }
        } else {
            ensureRoutineTasksToday();
        }
        const dr = rDraft && rDraft.find(x => x.id === id);
        if (dr) dr.skipDate = r.skipDate;
        save(); render(); renderRoutines();
    }

    // ════════════════════════════════════════════════════════
    // タスク
    // ════════════════════════════════════════════════════════
    // 「レポート 60分 明日」→ { text, duration, date }
    function parseInput(raw) {
        let text = ' ' + raw + ' ';
        let duration = 0, date = today(), m;
        if ((m = text.match(/\s(\d+(?:\.\d+)?)\s*(時間|h)(?=\s)/i))) {
            duration = Math.round(parseFloat(m[1]) * 60); text = text.replace(m[0], ' ');
        } else if ((m = text.match(/\s(\d+)\s*(分|m|min)(?=\s)/i))) {
            duration = parseInt(m[1], 10); text = text.replace(m[0], ' ');
        }
        if (/\s明日(?=\s)/.test(text)) { date = addDays(today(), 1); text = text.replace(/\s明日(?=\s)/, ' '); }
        else if (/\s今日(?=\s)/.test(text)) { text = text.replace(/\s今日(?=\s)/, ' '); }
        text = text.replace(/\s+/g, ' ').trim() || raw.trim();
        return { text, duration, date };
    }

    function addTask(raw, extra = {}) {
        const p = parseInput(raw);
        if (!p.text) return null;
        const task = {
            id: genId(), text: p.text, duration: p.duration, tag: 'タスク',
            date: p.date, completed: false, isRoutine: false, ...extra
        };
        state.tasks.push(task);
        save();
        return task;
    }

    function setCompleted(task, done) {
        task.completed = done;
        if (task.gtaskId) {
            const ids = state.settings.gsync.doneGtaskIds;
            const i = ids.indexOf(task.gtaskId);
            if (done && i < 0) ids.push(task.gtaskId);
            if (!done && i >= 0) ids.splice(i, 1);
            if (ids.length > 500) ids.splice(0, ids.length - 500);
        }
    }

    function toggleTask(id) {
        const task = state.tasks.find(t => t.id === id);
        if (!task) return;
        setCompleted(task, !task.completed);
        if (task.completed) cleanPaused();
        save(); render();
    }

    function deleteTask(id) {
        const task = state.tasks.find(t => t.id === id);
        if (!task) return;
        if (task.isRoutine) {
            // 毎日のタスクの × は「今日だけスキップ」。登録そのものは毎日のタスク画面で消す
            const r = state.routines.find(x => x.id === task.routineId);
            if (r) r.skipDate = task.date;
        }
        if (task.gtaskId) setCompleted(task, true); // 同期で戻ってこないようにする
        if (state.timer.taskId === id) resetTimer();
        state.pausedTimers = state.pausedTimers.filter(p => p.taskId !== id);
        state.tasks = state.tasks.filter(t => t.id !== id);
        save(); render();
    }

    function moveOverdueToToday() {
        const d = today();
        state.tasks.forEach(t => { if (!t.completed && t.date < d) t.date = d; });
        save(); render();
    }

    // ════════════════════════════════════════════════════════
    // タイマー
    // ════════════════════════════════════════════════════════
    function elapsed() {
        const t = state.timer;
        let s = t.accumulatedSeconds || 0;
        if (t.isRunning && t.startTime) s += Math.floor((Date.now() - t.startTime) / 1000);
        return s;
    }
    function pausedSecondsOf(id) {
        if (state.timer.taskId === id) return elapsed();
        const p = state.pausedTimers.find(x => x.taskId === id);
        return p ? p.accumulatedSeconds : 0;
    }
    function resetTimer() {
        state.timer.taskId = null; state.timer.isRunning = false;
        state.timer.startTime = null; state.timer.accumulatedSeconds = 0;
    }
    function pauseTimer() {
        const t = state.timer;
        if (!t.isRunning) return;
        t.accumulatedSeconds = elapsed();
        t.isRunning = false; t.startTime = null;
    }

    // 一時停止中の計測を破棄（記録は残さない。タスク自体は残る）
    function discardPaused(id) {
        const task = state.tasks.find(t => t.id === id);
        const sec = pausedSecondsOf(id);
        if (!confirm(`「${task ? task.text : 'タスク'}」の一時停止中の計測（${fmtTimer(sec)}）を破棄しますか？`)) return;
        if (state.timer.taskId === id) resetTimer();
        state.pausedTimers = state.pausedTimers.filter(p => p.taskId !== id);
        save(); render();
        toast('一時停止中の計測を破棄しました');
    }

    function pausedLogs() {
        const list = state.pausedTimers.filter(p => p.accumulatedSeconds > 0).map(p => p.taskId);
        const t = state.timer;
        if (t.taskId && !t.isRunning && t.accumulatedSeconds > 0) list.push(t.taskId);
        return list;
    }

    function discardAllPaused() {
        const ids = pausedLogs();
        if (!ids.length || !confirm(`一時停止中の計測 ${ids.length} 件をすべて破棄しますか？`)) return;
        if (!state.timer.isRunning) resetTimer();
        state.pausedTimers = [];
        save(); render();
        toast(`${ids.length} 件の計測を破棄しました`);
    }

    // 対象のタスクが消えた・完了した一時停止ログを片付ける
    function cleanPaused() {
        const alive = id => state.tasks.some(t => t.id === id && !t.completed);
        state.pausedTimers = state.pausedTimers.filter(p => alive(p.taskId));
        if (state.timer.taskId && !alive(state.timer.taskId)) resetTimer();
    }

    function toggleTimer(id) {
        const t = state.timer;
        if (t.taskId === id) {
            if (t.isRunning) pauseTimer();
            else { t.isRunning = true; t.startTime = Date.now(); }
        } else {
            // 計測中・一時停止中のタスクは退避してから切り替える
            if (t.taskId) {
                pauseTimer();
                if (t.accumulatedSeconds > 0) {
                    state.pausedTimers = state.pausedTimers.filter(p => p.taskId !== t.taskId);
                    state.pausedTimers.push({ taskId: t.taskId, accumulatedSeconds: t.accumulatedSeconds });
                }
            }
            const i = state.pausedTimers.findIndex(p => p.taskId === id);
            t.accumulatedSeconds = i >= 0 ? state.pausedTimers.splice(i, 1)[0].accumulatedSeconds : 0;
            t.taskId = id; t.isRunning = true; t.startTime = Date.now();
        }
        save(); render();
    }

    function finishTimer() {
        const total = elapsed();
        const task = state.tasks.find(x => x.id === state.timer.taskId);
        if (!task) { resetTimer(); save(); render(); return; }
        if (total < 60) { toast('1分未満なので記録しません。計測は続けられます。'); return; }
        const now = new Date();
        const start = new Date(now.getTime() - total * 1000); // 一時停止をはさんでも長さが正しくなるよう逆算
        state.schedules.push({
            id: genId(), title: `⏱ ${task.text}`, date: today(),
            startTime: hm(start), endTime: hm(now), tag: 'record', taskTag: task.tag || 'タスク',
            memo: `計測時間: ${fmtTimer(total)}`
        });
        setCompleted(task, true);
        resetTimer();
        save(); render();
        toast(`「${task.text}」を ${fmtMins(total)} で記録しました`);
    }

    // ════════════════════════════════════════════════════════
    // Google 連携
    // ════════════════════════════════════════════════════════
    let token = null;
    try {
        const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
        if (t && t.expires_at > Date.now() + 60000) token = t;
    } catch (e) { /* ignore */ }
    const tokenValid = () => !!(token && token.expires_at > Date.now() + 60000);

    const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks.readonly';
    const CAL_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
    const CAL_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
    // 許可された権限（ログイン画面でチェックを外すと、その権限だけ付かない）
    const hasScope = sc => !token || !token.scope || token.scope.split(' ').includes(sc);

    function connect(prompt = '') {
        return new Promise((resolve, reject) => {
            if (!window.google || !google.accounts || !google.accounts.oauth2) {
                reject(new Error('Googleのログイン用スクリプトを読み込めませんでした。通信状態を確認してください。'));
                return;
            }
            const client = google.accounts.oauth2.initTokenClient({
                client_id: state.settings.clientId,
                // 前回と同じアカウントを指定して、アカウント選択を省く
                login_hint: state.settings.gsync.email || (currentUser && currentUser.email) || undefined,
                scope: SCOPE,
                callback: resp => {
                    if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
                    token = { access_token: resp.access_token, scope: resp.scope || '',
                        expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
                    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch (e) { /* ignore */ }
                    // 次回からは自動で接続する
                    state.settings.gsync.autoConnect = true;
                    if (!state.settings.gsync.email && currentUser && currentUser.email) state.settings.gsync.email = currentUser.email;
                    resolve();
                },
                error_callback: err => reject(new Error((err && err.message) || 'ログインがキャンセルされました'))
            });
            client.requestAccessToken({ prompt });
        });
    }

    // ── 自動接続 ───────────────────────────────────────────
    // ブラウザはページを開いただけでは Google のログイン画面（ポップアップ）を開かせないため、
    // 開いた直後の最初の操作（タップ・クリック・キー入力）に合わせて自動で接続する。
    // 一度許可していれば、ポップアップは一瞬開いてすぐ閉じる（ボタン操作は不要）。
    let autoArmed = false;
    function armAutoConnect() {
        const g = state.settings.gsync;
        if (autoArmed || gasReady() || !g.autoConnect || tokenValid()) return;
        autoArmed = true;
        const handler = e => {
            // 「Googleと同期」ボタンなら、そちらの処理に任せる
            if (e.target && e.target.closest && e.target.closest('[data-act="sync"],[data-act="reconsent"],dialog')) return;
            document.removeEventListener('click', handler, true);
            document.removeEventListener('keydown', handler, true);
            autoArmed = false;
            if (!tokenValid() && !busy) syncAll({ interactive: true });
        };
        document.addEventListener('click', handler, true);
        document.addEventListener('keydown', handler, true);
        renderSchedule();
    }

    function disconnect() {
        state.settings.gsync.autoConnect = false;
        save();
        if (token && window.google && google.accounts && google.accounts.oauth2) {
            try { google.accounts.oauth2.revoke(token.access_token, () => {}); } catch (e) { /* ignore */ }
        }
        token = null;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    }

    async function api(url, opts = {}) {
        if (!tokenValid()) throw new Error('NO_TOKEN');
        const res = await fetch(url, {
            ...opts,
            headers: { 'Authorization': 'Bearer ' + token.access_token, 'Content-Type': 'application/json', ...(opts.headers || {}) }
        });
        if (res.status === 401) {
            token = null;
            try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
            throw new Error('NO_TOKEN');
        }
        if (!res.ok) {
            let msg = '', reason = '';
            try {
                const j = await res.json();
                msg = (j.error && j.error.message) || '';
                const det = (j.error && j.error.details) || [];
                reason = (det.find(x => x.reason) || {}).reason || ((j.error && j.error.errors && j.error.errors[0]) || {}).reason || (j.error && j.error.status) || '';
            } catch (e) { /* ignore */ }
            const err = new Error(`${res.status} ${msg}`.trim());
            err.status = res.status; err.reason = reason; err.apiMessage = msg;
            throw err;
        }
        return res.status === 204 ? null : res.json();
    }

    // Google ToDo → タスク
    const tasksUpdatedMin = () => new Date(Date.now() - 60 * 86400000).toISOString();

    async function pullGoogleTasks() {
        const updatedMin = tasksUpdatedMin();
        const lists = await api(`${TASKS_API}/users/@me/lists?maxResults=100`);
        const all = [];
        for (const list of (lists.items || [])) {
            let pageToken = '';
            do {
                const q = new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100', updatedMin });
                if (pageToken) q.set('pageToken', pageToken);
                const res = await api(`${TASKS_API}/lists/${encodeURIComponent(list.id)}/tasks?${q}`);
                all.push(...(res.items || []));
                pageToken = res.nextPageToken || '';
            } while (pageToken);
        }
        applyGoogleTasks(all);
    }

    // Google ToDo の一覧をアプリのタスクに反映
    function applyGoogleTasks(items) {
        const g = state.settings.gsync;
        const d = today();
        const seen = new Set();
        for (const gt of items) {
            const title = (gt.title || '').trim();
            if (!title) continue;
            seen.add(gt.id);
            const local = state.tasks.find(t => t.gtaskId === gt.id);
            if (gt.status === 'completed' || gt.deleted) {
                if (local && !local.completed) setCompleted(local, true);
                continue;
            }
            if (g.doneGtaskIds.includes(gt.id)) continue; // アプリで完了・削除済み
            let date = gt.due ? gt.due.substring(0, 10) : d;
            if (date < d) date = d;
            if (local) {
                local.text = title;
                if (!local.completed) local.date = date;
            } else {
                state.tasks.push({ id: genId(), gtaskId: gt.id, source: 'gtasks', text: title,
                    duration: 0, tag: 'タスク', date, completed: false, isRoutine: false });
            }
        }
        // Google 側で消えた未完了タスクは外す（計測中・一時停止中のものは残す）
        state.tasks = state.tasks.filter(t => !t.gtaskId || t.completed || seen.has(t.gtaskId)
            || t.id === state.timer.taskId || state.pausedTimers.some(p => p.taskId === t.id));
    }

    // カレンダー → 今日の予定（表示のみ）
    // 今日（0時〜翌5時）の範囲
    function eventRange() {
        const [y, m, dd] = today().split('-').map(Number);
        return { timeMin: new Date(y, m - 1, dd, 0, 0).toISOString(), timeMax: new Date(y, m - 1, dd + 1, DAY_BOUNDARY_HOUR, 0).toISOString() };
    }
    function applyEvents(items) {
        items.sort((a, b) => a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : (a.startDate + a.start).localeCompare(b.startDate + b.start));
        state.settings.gsync.todayEvents = { date: today(), items };
    }

    async function pullCalendarEvents() {
        const g = state.settings.gsync;
        const { timeMin, timeMax } = eventRange();
        const ids = ['primary', ...(state.settings.additionalCalendarIds || [])].filter(id => id && id !== g.calendarId);
        const items = [];
        for (const calId of ids) {
            let res;
            try {
                const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', timeZone: 'Asia/Tokyo', maxResults: '100' });
                res = await api(`${CAL_API}/calendars/${encodeURIComponent(calId)}/events?${q}`);
            } catch (e) {
                if (e.message === 'NO_TOKEN' || calId === 'primary') throw e;
                console.warn('[calendar]', calId, e);
                continue;
            }
            (res.items || []).forEach(ev => {
                if (ev.status === 'cancelled') return;
                const priv = ev.extendedProperties && ev.extendedProperties.private;
                if (priv && priv.dfRecordId) return;
                const allDay = !ev.start.dateTime;
                items.push({
                    title: ev.summary || '予定', allDay,
                    startDate: allDay ? ev.start.date : ev.start.dateTime.substring(0, 10),
                    start: allDay ? '' : ev.start.dateTime.substring(11, 16),
                    end: allDay ? '' : ev.end.dateTime.substring(11, 16)
                });
            });
        }
        applyEvents(items);
    }

    // 実績 → 専用カレンダー
    function isRecordDue(rec, now = new Date()) {
        const g = state.settings.gsync;
        if (rec.tag !== 'record' || rec.gsyncEventId || !g.since || rec.date < g.since) return false;
        const d = today();
        if (rec.date < d) return true;
        const h = now.getHours();
        return rec.date === d && (h >= PUSH_HOUR || h < DAY_BOUNDARY_HOUR);
    }
    const pendingRecords = now => state.schedules.filter(r => isRecordDue(r, now));

    // 記録の日付はアプリの1日（5時区切り）なので、0〜5時の記録は翌日の暦日にする
    function recordDateTimes(rec) {
        let startDate = rec.date;
        if (rec.startTime < pad(DAY_BOUNDARY_HOUR) + ':00') startDate = addDays(rec.date, 1);
        let endDate = rec.endTime < rec.startTime ? addDays(startDate, 1) : startDate;
        let end = rec.endTime;
        if (endDate === startDate && end === rec.startTime) {
            const [hh, mm] = end.split(':').map(Number);
            const t = hh * 60 + mm + 1;
            end = `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
            if (t >= 1440) endDate = addDays(startDate, 1);
        }
        return { start: `${startDate}T${rec.startTime}:00`, end: `${endDate}T${end}:00` };
    }

    async function ensureRecordCalendar() {
        const g = state.settings.gsync;
        if (g.calendarId) {
            try { await api(`${CAL_API}/calendars/${encodeURIComponent(g.calendarId)}`); return g.calendarId; }
            catch (e) { if (e.message === 'NO_TOKEN') throw e; g.calendarId = null; }
        }
        const cal = await api(`${CAL_API}/calendars`, {
            method: 'POST',
            body: JSON.stringify({ summary: REC_CAL_NAME, timeZone: 'Asia/Tokyo', description: 'Daily Flow のタイマーで計測した実績（自動登録）' })
        });
        g.calendarId = cal.id;
        save();
        return cal.id;
    }

    function recordPayload(rec) {
        const { start, end } = recordDateTimes(rec);
        return { id: rec.id, title: REC_PREFIX + (rec.title || '').replace(/^⏱\s*/, ''),
            start, end, description: `${rec.memo || ''}\nDaily Flow のタイマー記録` };
    }

    async function pushRecords() {
        const recs = pendingRecords();
        if (!recs.length) return 0;
        const calId = await ensureRecordCalendar();
        const base = `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`;
        let n = 0;
        for (const rec of recs) {
            // 二重登録防止
            const found = await api(`${base}?${new URLSearchParams({ privateExtendedProperty: 'dfRecordId=' + rec.id, maxResults: '1' })}`);
            if (found.items && found.items.length) { rec.gsyncEventId = found.items[0].id; continue; }
            const { start, end } = recordDateTimes(rec);
            const ev = await api(base, {
                method: 'POST',
                body: JSON.stringify({
                    summary: REC_PREFIX + (rec.title || '').replace(/^⏱\s*/, ''),
                    description: `${rec.memo || ''}\nDaily Flow のタイマー記録`,
                    start: { dateTime: start, timeZone: 'Asia/Tokyo' },
                    end: { dateTime: end, timeZone: 'Asia/Tokyo' },
                    extendedProperties: { private: { dfRecordId: rec.id } }
                })
            });
            rec.gsyncEventId = ev.id;
            n++;
            save();
        }
        return n;
    }

    // ── 自動ログイン用の中継（Google Apps Script） ─────────────
    // 自分の Google アカウントで動くスクリプトを経由するので、アプリ側でのログインが要らない。
    const gasReady = () => !!(state.settings.gas && state.settings.gas.url && state.settings.gas.key);
    const googleReady = () => gasReady() || tokenValid();

    async function gasCall(action, payload) {
        const { url, key } = state.settings.gas;
        let res;
        if (payload) {
            // text/plain の POST にして、ブラウザの事前確認（CORS preflight）を避ける
            res = await fetch(url, { method: 'POST', body: JSON.stringify({ key, action, ...payload }) });
        } else {
            const q = new URLSearchParams({ key, action });
            if (action === 'today') {
                const r = eventRange();
                q.set('timeMin', r.timeMin); q.set('timeMax', r.timeMax);
                q.set('calendars', (state.settings.additionalCalendarIds || []).join(','));
                q.set('updatedMin', tasksUpdatedMin());
            }
            res = await fetch(`${url}${url.includes('?') ? '&' : '?'}${q}`);
        }
        if (!res.ok) throw new Error(`中継スクリプトに接続できません（${res.status}）`);
        let data;
        try { data = await res.json(); }
        catch (e) { throw new Error('中継スクリプトの応答を読めません。デプロイの「アクセスできるユーザー」が「全員」になっているか確認してください'); }
        if (!data.ok) {
            throw new Error(data.error === 'unauthorized'
                ? '合言葉が一致しません。Code.gs の SECRET とアプリの合言葉を同じにしてください'
                : (data.error || '中継スクリプトでエラーが起きました'));
        }
        if (data.email) state.settings.gas.email = data.email;
        return data;
    }

    function gasPartError(part) {
        const msg = (part && part.error) || '不明なエラー';
        if (/TASKS_SERVICE_MISSING|Tasks is not defined/i.test(msg)) return { type: 'gas-tasks' };
        return { type: 'other', message: msg };
    }

    async function syncViaGas() {
        const g = state.settings.gsync;
        const data = await gasCall('today');
        if (data.events && data.events.ok) { applyEvents(data.events.items || []); gStatus.calendar = 'ok'; }
        else gStatus.calendar = { kind: 'calendar', ...gasPartError(data.events) };
        if (data.tasks && data.tasks.ok) { applyGoogleTasks(data.tasks.items || []); gStatus.tasks = 'ok'; }
        else gStatus.tasks = { kind: 'tasks', ...gasPartError(data.tasks) };
        const recs = pendingRecords();
        if (recs.length) {
            const r = await gasCall('push', { records: recs.map(recordPayload) });
            if (r.push && r.push.ok) {
                const map = new Map((r.push.items || []).map(x => [x.id, x.eventId]));
                let n = 0;
                recs.forEach(rec => { if (map.get(rec.id)) { rec.gsyncEventId = map.get(rec.id); n++; } });
                gStatus.push = 'ok';
                if (n) toast(`実績 ${n} 件を「${REC_CAL_NAME}」に登録しました`);
            } else {
                gStatus.push = { kind: 'push', ...gasPartError(r.push) };
            }
        }
        g.lastSyncAt = Date.now();
    }

    // Google の API エラーを、利用者がとるべき行動ごとに分ける
    function classifyGoogleError(e, kind) {
        const text = `${e.reason || ''} ${e.apiMessage || e.message || ''}`;
        if (/SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(text)) return { kind, type: 'api-disabled' };
        if (e.status === 403 && /SCOPE_INSUFFICIENT|insufficient(Permissions)?|insufficient authentication scopes/i.test(text)) return { kind, type: 'scope' };
        if (e.type === 'scope') return { kind, type: 'scope' };
        return { kind, type: 'other', message: e.message };
    }
    function scopeError() { const e = new Error('scope'); e.type = 'scope'; return e; }

    let busy = false, syncError = '';
    let gStatus = { calendar: null, tasks: null, push: null }; // null=未実行 / 'ok' / { type, ... }
    async function syncAll({ interactive = false } = {}) {
        if (busy) return;
        busy = true; syncError = ''; renderSchedule();
        try {
            if (gasReady()) {
                const g = state.settings.gsync;
                if (!g.since) g.since = today();
                gStatus = { calendar: null, tasks: null, push: null };
                try { await syncViaGas(); }
                catch (e) { console.warn('[gas]', e); syncError = e.message; }
                save();
                return;
            }
            if (!tokenValid()) {
                if (!interactive) return;
                await connect(typeof interactive === 'string' ? interactive : '');
            }
            const g = state.settings.gsync;
            if (!g.since) g.since = today();
            gStatus = { calendar: null, tasks: null, push: null };
            // それぞれ独立に実行し、1つ失敗しても他は続ける
            const step = async (kind, scope, fn) => {
                try {
                    if (!hasScope(scope)) throw scopeError();
                    await fn();
                    gStatus[kind] = 'ok';
                } catch (e) {
                    if (e.message === 'NO_TOKEN') throw e;
                    console.warn('[google]', kind, e);
                    gStatus[kind] = classifyGoogleError(e, kind);
                }
            };
            await step('calendar', CAL_READ_SCOPE, pullCalendarEvents);
            await step('tasks', TASKS_SCOPE, pullGoogleTasks);
            if (pendingRecords().length) {
                await step('push', CAL_WRITE_SCOPE, async () => {
                    const pushed = await pushRecords();
                    if (pushed) toast(`実績 ${pushed} 件を「${REC_CAL_NAME}」に登録しました`);
                });
            }
            g.lastSyncAt = Date.now();
            save();
        } catch (e) {
            if (e.message !== 'NO_TOKEN') { console.error('[sync]', e); syncError = '同期に失敗しました: ' + e.message; }
            else setTimeout(armAutoConnect, 0);
        } finally {
            busy = false;
            render();
        }
    }

    // ════════════════════════════════════════════════════════
    // クラウド同期（Firebase: Googleログイン + Firestore）
    //   以前の版と同じ users/{uid} ドキュメントを使う。
    //   書き込みは merge なので、以前の版の統計・ゴールなどのデータもクラウドに残る。
    // ════════════════════════════════════════════════════════
    const CLOUD_KEYS = ['tasks', 'routines', 'schedules', 'lastDate', 'settings', 'timer', 'pausedTimers'];
    let db = null, auth = null, currentUser = null;
    let cloudState = 'off';          // off | signedout | syncing | synced | pending | error
    let cloudSaveTimer = null, cloudFetchedOnce = false, lastCloudFetch = 0;

    function setCloudState(s) { cloudState = s; renderCloud(); }

    function initFirebase() {
        const conf = state.settings.firebaseConfig;
        if (!window.firebase || !conf) { setCloudState('off'); return; }
        try {
            if (!firebase.apps.length) firebase.initializeApp(conf);
            if (!db) {
                db = firebase.firestore();
                // オフライン中の書き込みを溜めて、回復時に自動送信
                db.enablePersistence({ synchronizeTabs: true }).catch(err => {
                    if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') console.warn('[cloud] persistence', err);
                });
            }
            if (!auth) {
                auth = firebase.auth();
                auth.onAuthStateChanged(user => {
                    currentUser = user || null;
                    if (user) {
                        if (!cloudFetchedOnce) { cloudFetchedOnce = true; fetchCloud(); }
                        else setCloudState('synced');
                    } else {
                        cloudFetchedOnce = false;
                        setCloudState('signedout');
                    }
                });
            }
        } catch (e) {
            console.error('[cloud] init', e);
            setCloudState('error');
        }
    }

    function cloudLogin() {
        if (!auth) { toast('先に Firebase の設定を保存してください'); return; }
        auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
            .catch(err => toast('ログインできませんでした: ' + err.message));
    }
    function cloudLogout() { if (auth) auth.signOut(); }

    function scheduleCloudSave() {
        if (!db || !currentUser) return;
        if (cloudState !== 'syncing') setCloudState('pending');
        clearTimeout(cloudSaveTimer);
        cloudSaveTimer = setTimeout(saveToCloud, 2000);
    }

    async function saveToCloud() {
        if (!db || !currentUser) return;
        clearTimeout(cloudSaveTimer); cloudSaveTimer = null;
        setCloudState('syncing');
        try {
            const data = {};
            // Firestore は undefined を受け付けないので JSON を通して落とす
            CLOUD_KEYS.forEach(k => { if (state[k] !== undefined) data[k] = JSON.parse(JSON.stringify(state[k])); });
            await db.collection('users').doc(currentUser.uid).set(data, { merge: true });
            if (!cloudSaveTimer) {
                state.cloudDirty = false;
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
            }
            setCloudState(cloudSaveTimer ? 'pending' : 'synced');
        } catch (e) {
            console.error('[cloud] save', e);
            setCloudState(navigator.onLine ? 'error' : 'pending');
        }
    }

    function unionById(primary, secondary) {
        const ids = new Set(primary.map(x => x.id));
        return [...primary, ...secondary.filter(x => x && !ids.has(x.id))];
    }

    async function fetchCloud() {
        if (!db || !currentUser) return;
        setCloudState('syncing');
        try {
            const snap = await db.collection('users').doc(currentUser.uid).get();
            lastCloudFetch = Date.now();
            if (!snap.exists) { await saveToCloud(); return; } // 初回: 手元のデータを上げる
            const c = snap.data() || {};
            const d = today();
            const localFirst = !!state.cloudDirty; // 未送信の変更があるときは手元を優先

            // 設定: クラウドを基本に、Google ToDo の完了済みID・削除した毎日のタスクIDは両方を合わせる
            const localDone = state.settings.gsync.doneGtaskIds || [];
            const localEvents = state.settings.gsync.todayEvents;
            const localDeleted = state.settings.deletedRoutineIds || [];
            const localResetAt = state.settings.routineResetAt;
            state.settings = localFirst ? { ...(c.settings || {}), ...state.settings } : { ...state.settings, ...(c.settings || {}) };
            state.settings.deletedRoutineIds = Array.from(new Set([...(state.settings.deletedRoutineIds || []), ...localDeleted])).slice(-500);
            // 片付けの基準時刻は早いほうに合わせる（他の端末で新しく登録した分を消さないため）
            if (localResetAt && (!state.settings.routineResetAt || localResetAt < state.settings.routineResetAt)) {
                state.settings.routineResetAt = localResetAt;
            }
            if (!state.settings.gsync) state.settings.gsync = {};
            const g = state.settings.gsync;
            if (!Array.isArray(g.doneGtaskIds)) g.doneGtaskIds = [];
            g.doneGtaskIds = Array.from(new Set([...(g.doneGtaskIds || []), ...localDone])).slice(-500);
            if (localEvents && (!g.todayEvents || localEvents.date >= g.todayEvents.date)) g.todayEvents = localEvents;

            // 実績・毎日のタスク: 両方を合わせる（同じIDはクラウド優先）
            const merge = (cloudArr, localArr) => localFirst ? unionById(localArr, cloudArr || []) : unionById(cloudArr || [], localArr);
            state.schedules = merge(c.schedules, state.schedules);
            state.routines = merge(c.routines, state.routines);

            // タスク: 同じIDはクラウド優先、手元にしかないもの（未送信の追加分）は残す
            const cloudDate = c.lastDate || '';
            state.tasks = merge(c.tasks, state.tasks)
                .filter((t, i, arr) => !t.gtaskId || arr.findIndex(x => x.gtaskId === t.gtaskId) === i);
            if (cloudDate > state.lastDate) state.lastDate = cloudDate;
            // アプリで完了・削除した Google ToDo は外す
            state.tasks = state.tasks.filter(t => !t.gtaskId || t.completed || !g.doneGtaskIds.includes(t.gtaskId));

            // タイマー: 手元で計測中なら手元、そうでなければクラウド
            if (!(state.timer && state.timer.isRunning) && c.timer) {
                state.timer = { taskId: c.timer.taskId || null, startTime: c.timer.startTime || null,
                    isRunning: !!c.timer.isRunning, accumulatedSeconds: c.timer.accumulatedSeconds || 0 };
                state.pausedTimers = c.pausedTimers || [];
            }

            // 毎日のタスク: 同じ日に2台で作られた分は1つにまとめる
            state.tasks = state.tasks.filter((t, i, arr) => !t.isRoutine ||
                arr.findIndex(x => x.isRoutine && x.routineId === t.routineId && x.date === t.date) === i || t.id === state.timer.taskId);
            cleanRoutines();
            if (cloudDate < d) state.lastDate = cloudDate; // 日付が古ければ繰り越し処理をやり直す
            rollover();
            ensureRoutineTasksToday();
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
            render();
            await saveToCloud();
        } catch (e) {
            console.error('[cloud] fetch', e);
            setCloudState(navigator.onLine ? 'error' : 'pending');
        }
    }

    function renderCloud() {
        const btn = $('cloud-status');
        if (btn) {
            const map = {
                off: ['', ''],
                signedout: ['☁ 端末間同期：未ログイン', 'warn'],
                syncing: ['☁ 端末間同期：送信中…', ''],
                pending: [navigator.onLine ? '☁ 端末間同期：送信待ち' : '☁ 端末間同期：オフライン', 'warn'],
                synced: ['☁ 端末間同期 ✓', 'ok'],
                error: ['☁ 端末間同期：エラー', 'bad']
            };
            const [label, cls] = map[cloudState] || ['', ''];
            btn.textContent = label;
            btn.className = 'cloud-status ' + cls;
            btn.style.display = label ? '' : 'none';
        }
        const box = $('cloud-account');
        if (box) {
            if (!state.settings.firebaseConfig) {
                box.innerHTML = '<p class="muted">Firebase の設定が未入力です。下の「Firebase の設定」に firebaseConfig を貼り付けてください。</p>';
            } else if (currentUser) {
                box.innerHTML = `
                    ${currentUser.photoURL ? `<img src="${esc(currentUser.photoURL)}" alt="" referrerpolicy="no-referrer">` : ''}
                    <div class="account-info"><div>${esc(currentUser.displayName || currentUser.email || 'ユーザー')}</div>
                    <div class="muted small-text">${cloudState === 'synced' ? '同期済み ✓' : cloudState === 'error' ? '同期エラー' : '同期中…'}</div></div>
                    <button type="button" class="btn secondary small" data-act="cloud-logout">ログアウト</button>`;
            } else {
                box.innerHTML = `<button type="button" class="btn primary" data-act="cloud-login">Googleでログイン</button>`;
            }
        }
    }

    // ════════════════════════════════════════════════════════
    // 表示
    // ════════════════════════════════════════════════════════
    function render() {
        renderHeader();
        renderSchedule();
        renderNowBar();
        renderCarryBar();
        renderPausedBar();
        renderTasks();
    }

    function renderHeader() {
        const now = new Date();
        $('date-display').textContent = now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
        const d = today();
        const todays = state.tasks.filter(t => t.date <= d);
        const done = todays.filter(t => t.completed).length;
        const mins = state.schedules.filter(r => r.tag === 'record' && r.date === d)
            .reduce((s, r) => s + (parseMemoSeconds(r.memo) || 0), 0);
        $('progress-text').textContent = todays.length
            ? `完了 ${done} / ${todays.length}${mins ? '・計測 ' + fmtMins(mins) : ''}`
            : 'タスクを1つ書いて始めましょう';
    }
    function parseMemoSeconds(memo) {
        const m = (memo || '').match(/(\d+):(\d+):(\d+)/);
        return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
    }

    function renderSchedule() {
        const g = state.settings.gsync;
        const d = today();
        const ev = g.todayEvents && g.todayEvents.date === d ? g.todayEvents.items : null;
        const nowHM = hm(new Date());
        let body;
        if (!ev) {
            body = `<p class="muted">${busy ? '読み込み中…' : '「Googleと同期」を押すと、今日の予定と Google ToDo を読み込みます。'}</p>`;
        } else if (!ev.length) {
            body = '<p class="muted">今日の予定はありません。</p>';
        } else {
            body = '<ul class="events">' + ev.map(e => {
                let cls = '';
                if (!e.allDay && e.startDate === d) {
                    if (e.end > e.start && e.end <= nowHM) cls = 'past';
                    else if (e.start <= nowHM && (nowHM < e.end || e.end <= e.start)) cls = 'now';
                } else if (!e.allDay && e.startDate > d) {
                    cls = '';
                }
                return `<li class="${cls}"><span class="time">${e.allDay ? '終日' : e.start + '〜' + e.end}</span><span>${esc(e.title)}</span></li>`;
            }).join('') + '</ul>';
        }

        const todayRecs = state.schedules.filter(r => r.tag === 'record' && r.date === d);
        const pending = g.since ? pendingRecords().length : 0;
        let rec = '';
        if (pending) {
            rec = `<p class="rec">📤 カレンダー未登録の実績が ${pending} 件あります <button type="button" class="btn secondary small" data-act="sync">今すぐ登録</button></p>`;
        } else if (todayRecs.length) {
            const allPushed = todayRecs.every(r => r.gsyncEventId);
            rec = `<p class="rec">⏱ 今日の実績 ${todayRecs.length} 件 — ${allPushed ? `「${REC_CAL_NAME}」に登録済み` : `${PUSH_HOUR}時以降に「${REC_CAL_NAME}」へ登録します`}</p>`;
        }

        const connected = googleReady();
        const status = busy ? '読み込み中…'
            : gasReady() ? (g.lastSyncAt ? `Google（自動）最終取得 ${hm(new Date(g.lastSyncAt))}` : 'Google（自動）')
            : connected ? (g.lastSyncAt ? `Google 最終取得 ${hm(new Date(g.lastSyncAt))}` : 'Google 接続済み')
            : g.autoConnect ? 'Google：画面に触れると自動で接続'
            : (g.lastSyncAt ? 'Google 再接続が必要' : 'Google 未接続');

        // カレンダー／ToDo／実績の登録 それぞれの結果
        const label = { calendar: 'カレンダー', tasks: 'Google ToDo', push: '実績の登録' };
        const mark = k => gStatus[k] === 'ok' ? `<span class="src ok">${label[k]} ✓</span>`
            : gStatus[k] ? `<span class="src bad">${label[k]} ✕</span>` : '';
        const marks = connected && !busy ? ['calendar', 'tasks', 'push'].map(mark).join('') : '';
        const projectNo = (state.settings.clientId || '').split('-')[0];
        const apiName = { calendar: 'calendar-json.googleapis.com', tasks: 'tasks.googleapis.com', push: 'calendar-json.googleapis.com' };
        const apiLabel = { calendar: 'Google Calendar API', tasks: 'Google Tasks API', push: 'Google Calendar API' };
        const problems = ['calendar', 'tasks', 'push'].filter(k => gStatus[k] && gStatus[k] !== 'ok').map(k => {
            const st = gStatus[k];
            if (st.type === 'gas-tasks') {
                return `<div class="problem"><p><b>${label[k]}</b>：中継スクリプトに「Google Tasks API」サービスが追加されていません。Apps Script の左の「サービス」＋ から追加し、もう一度デプロイしてください。</p></div>`;
            }
            if (st.type === 'scope') {
                return `<div class="problem"><p><b>${label[k]}</b>：ログイン時にこの権限が許可されていません（許可画面でチェックが外れていた可能性があります）。</p>
                    <button type="button" class="btn secondary small" data-act="reconsent">権限を許可し直す</button></div>`;
            }
            if (st.type === 'api-disabled') {
                const url = `https://console.cloud.google.com/apis/library/${apiName[k]}${/^\d+$/.test(projectNo) ? '?project=' + projectNo : ''}`;
                return `<div class="problem"><p><b>${label[k]}</b>：Google Cloud のプロジェクトで ${apiLabel[k]} が有効になっていません。</p>
                    <p><a href="${url}" target="_blank" rel="noopener">${apiLabel[k]} を有効にする ↗</a>（有効にしてから数分待って「Googleと同期」）</p></div>`;
            }
            return `<div class="problem"><p><b>${label[k]}</b>：読み込めませんでした（${esc(st.message || '不明なエラー')}）</p></div>`;
        }).join('');

        $('schedule-panel').innerHTML = `
            <div class="panel-head">
                <h2>今日の予定</h2>
                <div class="head-actions">
                    <span class="muted small-text">${status}</span>
                    <button type="button" class="btn secondary small" data-act="sync" ${busy ? 'disabled' : ''}>⟳ Googleと同期</button>
                </div>
            </div>
            ${marks ? `<div class="srcs">${marks}</div>` : ''}
            ${body}${rec}
            ${problems ? `<div class="problems">${problems}</div>` : ''}
            ${syncError ? `<p class="error">${esc(syncError)}</p>` : ''}`;
    }

    function renderNowBar() {
        const bar = $('now-bar');
        const t = state.timer;
        const task = t.taskId && state.tasks.find(x => x.id === t.taskId);
        if (!task || (!t.isRunning && !t.accumulatedSeconds)) { bar.classList.remove('visible'); bar.innerHTML = ''; return; }
        bar.classList.add('visible');
        bar.innerHTML = `
            <div class="now-name">${t.isRunning ? '⏱ 計測中' : '⏸ 一時停止中'}：${esc(task.text)}</div>
            <div class="now-row">
                <span class="now-time" id="now-time">${fmtTimer(elapsed())}</span>
                <button type="button" class="btn secondary" data-act="timer" data-id="${task.id}">${t.isRunning ? '一時停止' : '再開'}</button>
                ${t.isRunning ? '' : `<button type="button" class="btn secondary" data-act="discard" data-id="${task.id}">破棄</button>`}
                <button type="button" class="btn primary" data-act="finish">完了して記録</button>
            </div>`;
    }

    function renderPausedBar() {
        const bar = $('paused-bar');
        const n = pausedLogs().length;
        if (n < 2) { bar.classList.remove('visible'); bar.innerHTML = ''; return; }
        bar.classList.add('visible');
        bar.innerHTML = `<span>⏸ 一時停止中の計測が ${n} 件あります</span><button type="button" class="btn secondary small" data-act="discard-all">すべて破棄</button>`;
    }

    function renderCarryBar() {
        const bar = $('carry-bar');
        const d = today();
        const n = state.tasks.filter(t => !t.completed && t.date < d).length;
        if (!n) { bar.classList.remove('visible'); bar.innerHTML = ''; return; }
        bar.classList.add('visible');
        bar.innerHTML = `<span>前日までの残りが ${n} 件あります</span><button type="button" class="btn secondary small" data-act="carry">今日に移す</button>`;
    }

    function taskRow(task) {
        const d = today();
        const t = state.timer;
        const running = t.taskId === task.id && t.isRunning;
        const sec = task.completed ? 0 : pausedSecondsOf(task.id);
        const meta = [];
        if (task.source === 'gtasks') meta.push('<span class="chip google">Google ToDo</span>');
        if (task.isRoutine) meta.push('<span class="chip">毎日</span>');
        if (task.date < d) meta.push(`<span class="chip old">${task.date.substring(5).replace('-', '/')}から</span>`);
        if (task.duration) meta.push(`<span>🕒 ${task.duration}分</span>`);
        if (sec && !running) meta.push(`<span class="paused-log">⏸ ${fmtTimer(sec)}<button type="button" class="link-btn" data-act="discard" data-id="${task.id}">破棄</button></span>`);
        return `
            <li class="task ${task.completed ? 'done' : ''} ${running ? 'running' : ''}">
                <button type="button" class="check ${task.completed ? 'on' : ''}" data-act="toggle" data-id="${task.id}" aria-label="完了"></button>
                <div class="task-body">
                    <div class="task-name">${esc(task.text)}</div>
                    ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
                </div>
                ${task.completed ? '' : `<button type="button" class="play ${running ? 'on' : ''}" data-act="timer" data-id="${task.id}" aria-label="${running ? '一時停止' : '計測開始'}">${running ? '❚❚' : '▶'}</button>`}
                <button type="button" class="del" data-act="delete" data-id="${task.id}" aria-label="削除">×</button>
            </li>`;
    }

    function renderRoutines() {
        const list = $('routine-list');
        if (!list || !rDraft) return;
        const d = today();
        const cur = new Map(state.routines.map(r => [r.id, r]));
        const doneToday = new Set(state.tasks.filter(t => t.isRoutine && t.date === d && t.completed).map(t => t.routineId));
        $('routine-count').textContent = rDraft.length;
        list.innerHTML = rDraft.length ? rDraft.map((r, i) => {
            const status = routineStatusHtml(r, cur, doneToday, d);
            return `
            <li data-id="${r.id}" class="${rSelected.has(r.id) ? 'selected' : ''}">
                <input type="checkbox" class="r-check" data-id="${r.id}" ${rSelected.has(r.id) ? 'checked' : ''} aria-label="選択">
                <div class="r-move">
                    <button type="button" data-act="r-up" data-id="${r.id}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">▲</button>
                    <button type="button" data-act="r-down" data-id="${r.id}" ${i === rDraft.length - 1 ? 'disabled' : ''} aria-label="下へ">▼</button>
                </div>
                <input type="text" class="r-name" data-id="${r.id}" value="${esc(r.text)}" aria-label="タスク名">
                <label class="r-min"><input type="number" class="r-dur" data-id="${r.id}" min="0" max="1440" value="${r.duration || ''}" placeholder="—" aria-label="時間（分）">分</label>
                <div class="r-status">${status}</div>
                <button type="button" class="del" data-act="r-remove" data-id="${r.id}" aria-label="削除">×</button>
            </li>`;
        }).join('') : '<li class="empty">まだ登録がありません。下の欄からまとめて追加できます。</li>';
        renderRoutineBar();
    }

    function routineStatusHtml(r, cur, doneToday, d) {
        const o = cur.get(r.id);
        const changed = !r.isNew && o && (o.text !== r.text.trim() || (o.duration || 0) !== (r.duration || 0));
        if (r.isNew) return '<span class="chip new">新規</span>';
        if (changed) return '<span class="chip edited">変更</span>';
        if (doneToday.has(r.id)) return '<span class="chip done">今日 完了</span>';
        if (o && o.skipDate === d) return `<span class="chip">今日はお休み</span><button type="button" class="link-btn" data-act="r-unskip" data-id="${r.id}">今日も出す</button>`;
        if (o) return `<button type="button" class="link-btn" data-act="r-skip" data-id="${r.id}">今日は休む</button>`;
        return '';
    }

    // 1行の状態表示だけ更新（一覧全体を描き直さないので、入力中のフォーカスが外れない）
    function updateRoutineRow(id) {
        const li = document.querySelector(`#routine-list li[data-id="${id}"]`);
        const r = rDraft && rDraft.find(x => x.id === id);
        if (!li || !r) return;
        const d = today();
        const cur = new Map(state.routines.map(x => [x.id, x]));
        const doneToday = new Set(state.tasks.filter(t => t.isRoutine && t.date === d && t.completed).map(t => t.routineId));
        li.querySelector('.r-status').innerHTML = routineStatusHtml(r, cur, doneToday, d);
    }

    // 選択・保存まわりの表示だけ更新（入力中のフォーカスを奪わない）
    function renderRoutineBar() {
        if (!rDraft) return;
        const ch = routineChanges();
        const n = rSelected.size;
        $('r-select-all').checked = rDraft.length > 0 && n === rDraft.length;
        $('r-select-all').indeterminate = n > 0 && n < rDraft.length;
        $('r-delete-selected').disabled = n === 0;
        $('r-delete-selected').textContent = n ? `選択した ${n} 件を削除` : '選択して削除';
        $('r-save-bar').classList.toggle('visible', ch.total > 0);
        $('r-save-text').textContent = `未保存の変更があります（${[
            ch.added && `追加 ${ch.added}`, ch.edited && `変更 ${ch.edited}`,
            ch.removed && `削除 ${ch.removed}`, ch.reordered && '並べ替え'].filter(Boolean).join('・')}）`;
        document.querySelectorAll('#routine-list li[data-id]').forEach(li => li.classList.toggle('selected', rSelected.has(li.dataset.id)));
    }

    // ── 画面の切り替え ─────────────────────────────────────
    function showView(name) {
        if (name === 'today' && rDraft && routineChanges().total > 0
            && !confirm('毎日のタスクに保存していない変更があります。破棄して戻りますか？')) return;
        if (name === 'routines') { startRoutineEdit(); renderRoutines(); }
        else rDraft = null;
        document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-' + name);
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
        window.scrollTo(0, 0);
    }

    function renderTasks() {
        const d = today();
        const active = state.tasks.filter(t => !t.completed && t.date <= d)
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const done = state.tasks.filter(t => t.completed && t.date <= d);
        const upcoming = state.tasks.filter(t => !t.completed && t.date > d).length;
        $('active-count').textContent = active.length;
        $('done-count').textContent = done.length;
        $('active-list').innerHTML = active.map(taskRow).join('')
            || '<li class="empty">今日のタスクはありません</li>';
        if (upcoming) $('active-list').insertAdjacentHTML('beforeend', `<li class="empty">明日以降のタスク ${upcoming} 件</li>`);
        $('done-list').innerHTML = done.map(taskRow).join('');
        $('done-box').style.display = done.length ? '' : 'none';
    }

    // ════════════════════════════════════════════════════════
    // イベント
    // ════════════════════════════════════════════════════════
    function setup() {
        document.addEventListener('click', e => {
            const el = e.target.closest('[data-act]');
            if (!el) return;
            const id = el.dataset.id;
            switch (el.dataset.act) {
                case 'toggle': toggleTask(id); break;
                case 'delete': deleteTask(id); break;
                case 'timer': toggleTimer(id); break;
                case 'finish': finishTimer(); break;
                case 'discard': discardPaused(id); break;
                case 'discard-all': discardAllPaused(); break;
                case 'carry': moveOverdueToToday(); break;
                case 'sync': syncAll({ interactive: true }); break;
                case 'reconsent': token = null; syncAll({ interactive: 'consent' }); break;
                case 'cloud-login': cloudLogin(); break;
                case 'view': showView(el.dataset.view); break;
                case 'r-skip': setRoutineSkip(id, true); break;
                case 'r-unskip': setRoutineSkip(id, false); break;
                case 'r-remove': rDraft = rDraft.filter(r => r.id !== id); rSelected.delete(id); renderRoutines(); break;
                case 'r-up': case 'r-down': {
                    const i = rDraft.findIndex(r => r.id === id), j = i + (el.dataset.act === 'r-up' ? -1 : 1);
                    if (i >= 0 && j >= 0 && j < rDraft.length) { [rDraft[i], rDraft[j]] = [rDraft[j], rDraft[i]]; renderRoutines(); }
                    break;
                }
                case 'r-save': saveRoutineEdits(); break;
                case 'r-revert': startRoutineEdit(); renderRoutines(); toast('変更を取り消しました'); break;
                case 'cloud-logout': cloudLogout(); break;
            }
        });

        const input = $('add-input');
        $('add-form').addEventListener('submit', e => {
            e.preventDefault();
            const raw = input.value.trim();
            if (!raw) { input.focus(); return; }
            const task = addTask(raw);
            if (!task) return;
            input.value = '';
            render();
            if (task.date > today()) toast(`「${task.text}」を ${task.date.substring(5).replace('-', '/')} に追加しました`);
        });
        $('btn-measure').addEventListener('click', () => {
            const raw = input.value.trim();
            if (!raw) { input.focus(); toast('計測する作業の名前を書いてください'); return; }
            const task = addTask(raw, { source: 'adhoc', date: today() });
            if (!task) return;
            task.date = today();
            input.value = '';
            toggleTimer(task.id);
        });

        // 毎日のタスク（一括管理）
        const list = $('routine-list');
        list.addEventListener('input', e => {
            const id = e.target.dataset.id;
            const r = rDraft && rDraft.find(x => x.id === id);
            if (!r) return;
            if (e.target.classList.contains('r-name')) r.text = e.target.value;
            if (e.target.classList.contains('r-dur')) r.duration = parseInt(e.target.value, 10) || 0;
            updateRoutineRow(id);
            renderRoutineBar();
        });
        list.addEventListener('change', e => {
            if (e.target.classList.contains('r-check')) {
                const id = e.target.dataset.id;
                if (e.target.checked) rSelected.add(id); else rSelected.delete(id);
                renderRoutineBar();
            }
        });
        $('r-select-all').addEventListener('change', e => {
            rSelected = e.target.checked ? new Set(rDraft.map(r => r.id)) : new Set();
            renderRoutines();
        });
        $('r-delete-selected').addEventListener('click', () => {
            if (!rSelected.size) return;
            rDraft = rDraft.filter(r => !rSelected.has(r.id));
            rSelected = new Set();
            renderRoutines();
            toast('削除は「変更を保存」で確定します');
        });
        $('routine-add-form').addEventListener('submit', e => {
            e.preventDefault();
            const ta = $('routine-add-text');
            const { added, dup } = draftAddLines(ta.value);
            if (!added && !dup) { ta.focus(); return; }
            ta.value = '';
            renderRoutines();
            toast(`${added} 件を追加しました${dup ? `（同じ名前の ${dup} 件は省きました）` : ''}。「変更を保存」で確定します`);
        });
        $('routine-add-text').addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('routine-add-form').requestSubmit(); }
        });
        window.addEventListener('beforeunload', e => {
            if (rDraft && routineChanges().total > 0) { e.preventDefault(); e.returnValue = ''; }
        });

        // 設定
        const dlg = $('settings-dialog');
        const openSettings = () => {
            $('client-id').value = state.settings.clientId || '';
            $('fb-config').value = state.settings.firebaseConfig ? JSON.stringify(state.settings.firebaseConfig, null, 2) : '';
            renderCloud();
            const g = state.settings.gsync;
            $('google-status').textContent = tokenValid()
                ? `接続中${g.calendarId ? `（実績の登録先: 「${REC_CAL_NAME}」）` : ''}`
                : '未接続（今日の予定の「Googleと同期」から接続します）';
            const gas = state.settings.gas || {};
            $('gas-key').value = gas.key || '';
            $('gas-url').value = gas.url || '';
            renderGasStatus();
            dlg.showModal();
        };
        const renderGasStatus = (msg) => {
            const gas = state.settings.gas || {};
            $('gas-status').textContent = msg || (gasReady()
                ? `✓ 自動ログイン設定済み${gas.email ? `（${gas.email}）` : ''}`
                : '未設定');
        };
        $('btn-gas-key').addEventListener('click', () => {
            if ($('gas-key').value && !confirm('合言葉を作り直しますか？（中継スクリプトの SECRET も貼り替えが必要になります）')) return;
            const a = new Uint8Array(18); crypto.getRandomValues(a);
            $('gas-key').value = Array.from(a, b => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 57]).join('');
        });
        $('btn-gas-copy').addEventListener('click', async () => {
            const v = $('gas-key').value;
            if (!v) { toast('先に「作る」を押してください'); return; }
            try { await navigator.clipboard.writeText(v); toast('合言葉をコピーしました'); }
            catch (e) { $('gas-key').select(); toast('選択したのでコピーしてください'); }
        });
        $('btn-gas-save').addEventListener('click', async () => {
            const url = $('gas-url').value.trim(), key = $('gas-key').value.trim();
            if (!key) { toast('合言葉を入れてください'); return; }
            if (!/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec(\?.*)?$/.test(url)) {
                toast('URLは https://script.google.com/macros/s/…/exec の形です'); return;
            }
            const prev = state.settings.gas;
            state.settings.gas = { url, key };
            renderGasStatus('接続テスト中…');
            try {
                await gasCall('ping');
                save();
                renderGasStatus();
                toast('自動ログインを設定しました');
                syncAll();
            } catch (e) {
                state.settings.gas = prev;
                renderGasStatus('✕ ' + e.message);
            }
        });
        $('btn-gas-clear').addEventListener('click', () => {
            if (!gasReady() || !confirm('自動ログインの設定を解除しますか？')) return;
            state.settings.gas = null;
            save(); renderGasStatus(); render();
        });
        $('btn-settings').addEventListener('click', openSettings);
        $('cloud-status').addEventListener('click', openSettings);
        $('btn-save-fb').addEventListener('click', () => {
            const str = $('fb-config').value.trim();
            if (!str) return;
            let conf;
            try {
                // 「const firebaseConfig = {...};」をそのまま貼っても読めるようにする
                const body = str.slice(str.indexOf('{'), str.lastIndexOf('}') + 1);
                try { conf = JSON.parse(body); }
                catch (e) { conf = JSON.parse(body.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"').replace(/,\s*}/g, '}')); }
                if (!conf.apiKey || !conf.projectId) throw new Error('apiKey と projectId が必要です');
            } catch (err) {
                toast('firebaseConfig を読めませんでした: ' + err.message);
                return;
            }
            const changed = JSON.stringify(conf) !== JSON.stringify(state.settings.firebaseConfig);
            state.settings.firebaseConfig = conf;
            save();
            if (changed && window.firebase && firebase.apps.length) {
                toast('保存しました。再読み込みすると新しい設定で接続します');
            } else {
                initFirebase(); renderCloud(); toast('保存しました');
            }
        });
        $('btn-save-client').addEventListener('click', () => {
            const v = $('client-id').value.trim();
            if (!v) return;
            state.settings.clientId = v;
            save(); toast('クライアントIDを保存しました');
        });
        $('btn-disconnect').addEventListener('click', () => {
            disconnect(); render(); toast('Googleとの接続を解除しました');
            $('google-status').textContent = '未接続';
        });
        $('btn-export').addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `daily-flow-backup-${today()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
        $('import-file').addEventListener('change', async e => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const data = JSON.parse(await file.text());
                if (!data || !Array.isArray(data.tasks)) throw new Error('Daily Flow のバックアップではありません');
                if (!confirm('今のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
                localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                load(); render(); dlg.close(); toast('復元しました');
            } catch (err) {
                toast('復元できませんでした: ' + err.message);
            } finally {
                e.target.value = '';
            }
        });

        // 1秒ごと: 計測時間の表示
        setInterval(() => {
            const el = $('now-time');
            if (el) el.textContent = fmtTimer(elapsed());
        }, 1000);

        // 1分ごと: 日付の切り替わり、23時以降の実績登録、予定の現在地の更新
        setInterval(() => {
            if (rollover()) render();
            if (!busy && googleReady() && pendingRecords().length) syncAll();
            else renderSchedule();
        }, 60000);

        // 画面に戻ってきたとき
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            if (rollover()) render();
            const g = state.settings.gsync;
            if (googleReady() && (!g.lastSyncAt || Date.now() - g.lastSyncAt > 10 * 60000)) syncAll();
            // 他の端末での変更を取り込む（未送信の変更があるときは先に送る）
            if (currentUser && Date.now() - lastCloudFetch > 60000) {
                if (cloudSaveTimer) saveToCloud().then(fetchCloud); else fetchCloud();
            }
        });
        // 閉じる・切り替える直前に、待っている変更をすぐ送る
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && cloudSaveTimer) saveToCloud();
        });
        window.addEventListener('pagehide', () => { if (cloudSaveTimer) saveToCloud(); });
        window.addEventListener('online', () => { if (currentUser) saveToCloud(); else renderCloud(); });
        window.addEventListener('offline', renderCloud);

        // 他のタブでの変更を反映
        window.addEventListener('storage', e => { if (e.key === STORAGE_KEY) { load(); render(); } });
    }

    // ════════════════════════════════════════════════════════
    // 起動
    // ════════════════════════════════════════════════════════
    load();
    setup();
    render();
    initFirebase();
    renderCloud();
    // 中継スクリプトがあれば、開いた時点で自動で読み込む（ログイン不要）
    if (googleReady()) setTimeout(() => syncAll(), 300);
    else armAutoConnect();
    // 1時間で接続が切れるので、切れたら次の操作でつなぎ直す
    setInterval(armAutoConnect, 30000);

    // テスト用
    window.__df = { state: () => state, cleanRoutines, showView, routineChanges, draft: () => rDraft, isRecordDue, recordDateTimes, parseInput, syncAll, finishTimer, toggleTimer };
})();
