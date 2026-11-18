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

    // 他のサイトの中に埋め込まれて動かされないようにする（クリックの乗っ取り対策）
    if (window.top !== window.self) {
        document.documentElement.innerHTML = '';
        try { window.top.location = window.self.location.href; } catch (e) { /* ignore */ }
        return;
    }

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

    // ── アプリ版: Android から直接 Google の許可をもらう ─────────────
    // 一度許可すれば、次からは画面を出さずにアクセストークンがもらえる（＝開いた時点で自動ログイン）
    // カレンダー・ToDo 用と、端末間同期のログイン用（メールアドレス・名前）
    const NATIVE_API_SCOPES = [CAL_READ_SCOPE, CAL_WRITE_SCOPE, TASKS_SCOPE];
    const NATIVE_LOGIN_SCOPES = ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
    function googleAuthPlugin() {
        if (!isNativeApp()) return null;
        const P = Capacitor.Plugins && Capacitor.Plugins.GoogleAuth;
        if (P) return P;
        return typeof Capacitor.registerPlugin === 'function' ? Capacitor.registerPlugin('GoogleAuth') : null;
    }
    const nativeAuthOn = () => isNativeApp() && !!state.settings.nativeGoogle;

    // interactive=true のときだけ許可画面を出す。false で許可がまだなら NEEDS_CONSENT
    async function nativeAuthorize(interactive) {
        const G = googleAuthPlugin();
        if (!G || typeof G.authorize !== 'function') {
            const e = new Error('この機能を使うには、アプリを新しい版に更新してください'); e.code = 'OLD_APP'; throw e;
        }
        let r;
        // まずはカレンダー・ToDo とログイン用をまとめて頼み、Google の内部エラーになったら
        // カレンダー・ToDo だけで頼み直す（組み合わせによって失敗する端末があるため）
        const sets = state.settings.nativeScopeMode === 'api'
            ? [NATIVE_API_SCOPES]
            : [[...NATIVE_API_SCOPES, ...NATIVE_LOGIN_SCOPES], NATIVE_API_SCOPES];
        let lastErr = null;
        for (const scopes of sets) {
            try {
                r = await G.authorize({ scopes, interactive });
                if (scopes === NATIVE_API_SCOPES && sets.length > 1) { state.settings.nativeScopeMode = 'api'; save(); }
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                const code = e.code || (e.data && e.data.code) || '';
                if (!/コード 8/.test(e.message || '') || /UNREGISTERED_ON_API_CONSOLE/.test(e.message || '')
                    || code === 'NEEDS_CONSENT' || code === 'CANCELED') break;
            }
        }
        if (lastErr) {
            const e = lastErr;
            const code = e.code || (e.data && e.data.code) || '';
            const unregistered = /UNREGISTERED_ON_API_CONSOLE/.test(e.message || '');
            const err = new Error(unregistered
                ? 'Google Cloud に Android のクライアント（パッケージ名 io.github.kouki8067.dailyflow と SHA-1）が登録されていません。Google Auth Platform →「クライアント」で Android のクライアントを作成してください（反映まで数分かかります）'
                : code === 'DEVELOPER_ERROR'
                ? 'Google Cloud にアプリ（パッケージ名とSHA-1）が登録されていません。設定手順を確認してください'
                : code === 'NEEDS_CONSENT' ? 'Google の許可が必要です'
                : (e.message || 'Google の許可を受け取れませんでした'));
            err.code = code;
            throw err;
        }
        if (!r) throw new Error('Google の許可を受け取れませんでした');
        token = { access_token: r.accessToken, scope: (r.grantedScopes || []).join(' '),
            // Android からは有効期限が返らないので、余裕をもって50分で取り直す
            expires_at: Date.now() + 50 * 60000 };
        try { localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch (e) { /* ignore */ }
        if (!state.settings.nativeGoogle) { state.settings.nativeGoogle = true; save(); }
        return token;
    }

    // 端末間同期のログイン用のトークン（メールアドレスの権限が必要）。カレンダー用のトークンに含まれていなければ別に頼む
    async function nativeLoginToken(interactive) {
        if (tokenValid() && hasScope(NATIVE_LOGIN_SCOPES[0])) return token.access_token;
        if (state.settings.nativeScopeMode !== 'api') {
            const t = await nativeAuthorize(interactive);
            if (hasScope(NATIVE_LOGIN_SCOPES[0])) return t.access_token;
        }
        const G = googleAuthPlugin();
        try {
            const r = await G.authorize({ scopes: NATIVE_LOGIN_SCOPES, interactive });
            return r.accessToken;
        } catch (e) {
            throw new Error(e.message || 'ログイン用の許可を受け取れませんでした');
        }
    }

    function connect(prompt = '') {
        // アプリ版は Android から直接許可をもらう（Google のログイン画面のポップアップは使えない）
        if (isNativeApp()) return nativeAuthorize(true).then(() => undefined);
        let timer;
        const p = new Promise((resolve, reject) => {
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
        // ログイン画面が閉じられたまま応答がないときに、いつまでも待たない
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Googleのログインが完了しませんでした')), 120000); });
        return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
    }

    // ── 自動接続 ───────────────────────────────────────────
    // ブラウザはページを開いただけでは Google のログイン画面（ポップアップ）を開かせないため、
    // 開いた直後の最初の操作（タップ・クリック・キー入力）に合わせて自動で接続する。
    // 一度許可していれば、ポップアップは一瞬開いてすぐ閉じる（ボタン操作は不要）。
    let autoArmed = false;
    function armAutoConnect() {
        const g = state.settings.gsync;
        if (autoArmed || isNativeApp() || gasReady() || !g.autoConnect || tokenValid()) return;
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
    const googleReady = () => gasReady() || tokenValid() || (isNativeApp() && !!state.settings.nativeGoogle);

    // 応答がないときに「読み込み中」のまま止まらないよう、時間を区切って待つ
    async function fetchWithTimeout(url, opts = {}, ms = 45000) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
        catch (e) {
            if (e.name === 'AbortError') throw new Error('中継スクリプトから応答がありません（時間切れ）。通信状態を確認して「Googleと同期」を押してください');
            throw new Error('中継スクリプトに接続できません。通信状態を確認してください');
        }
        finally { clearTimeout(timer); }
    }

    // 中継スクリプトの正しいアドレスか（ほかのサイトに合言葉や予定を送らないため）
    const GAS_URL_RE = /^https:\/\/script\.google\.com\/macros\/(?:a\/[\w.-]+\/)?s\/[\w-]+\/(?:exec|dev)(?:\?.*)?$/;
    const validGasUrl = url => GAS_URL_RE.test(String(url || ''));

    async function gasCall(action, payload) {
        const { url, key } = state.settings.gas;
        if (!validGasUrl(url)) throw new Error('中継スクリプトのURLが正しくありません（https://script.google.com/macros/s/…/exec の形）');
        const body = { key, action, ...(payload || {}) };
        if (action === 'today') {
            const r = eventRange();
            body.timeMin = r.timeMin; body.timeMax = r.timeMax;
            body.calendars = (state.settings.additionalCalendarIds || []).join(',');
            body.updatedMin = tasksUpdatedMin();
        }
        // 合言葉がURL（履歴・ログ）に残らないよう、いつも本文で送る。
        // text/plain の POST にして、ブラウザの事前確認（CORS preflight）を避ける
        const res = await fetchWithTimeout(url, { method: 'POST', body: JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!res.ok) throw new Error(`中継スクリプトに接続できません（${res.status}）`);
        let data;
        try { data = await res.json(); }
        catch (e) { throw new Error('中継スクリプトの応答を読めません。デプロイの「アクセスできるユーザー」が「全員」になっているか確認してください'); }
        if (!data.ok) {
            throw new Error(data.error === 'secret_not_set'
                ? 'スクリプトで setup をまだ実行していません。Apps Script の関数の選択欄で setup を選んで「実行」してください'
                : data.error === 'unauthorized'
                ? '合言葉が一致しません。Apps Script で setup をもう一度実行し、実行ログの「合言葉: 」の後ろをそのまま貼り付けてください'
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

    let busy = false, busySince = 0, syncError = '', nativeNeedsConsent = false;
    let gStatus = { calendar: null, tasks: null, push: null }; // null=未実行 / 'ok' / { type, ... }
    async function syncAll({ interactive = false } = {}) {
        // 前の読み込みが止まったままなら（2分以上）、やり直せるようにする
        if (busy && Date.now() - busySince < 120000) return;
        busySince = Date.now();
        busy = true; syncError = ''; renderSchedule();
        try {
            // アプリ版で直接の許可が有効なら、期限切れのトークンを画面なしで取り直す
            if (isNativeApp() && (nativeAuthOn() || interactive) && !tokenValid()) {
                try { await nativeAuthorize(!!interactive); }
                catch (e) {
                    if (e.code === 'NEEDS_CONSENT') { nativeNeedsConsent = true; }
                    else if (interactive || !gasReady()) { syncError = e.message; return; }
                }
            }
            if (gasReady() && !(isNativeApp() && tokenValid())) {
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

    async function cloudLogin() {
        if (!auth) { toast('先に Firebase の設定を保存してください'); return; }
        if (isNativeApp()) {
            // アプリ版: Android からもらったアクセストークンで Firebase にログインする
            try {
                const at = await nativeLoginToken(true);
                const cred = firebase.auth.GoogleAuthProvider.credential(null, at);
                await auth.signInWithCredential(cred);
                state.settings.cloudAutoLogin = true; save();
                toast('端末間同期にログインしました');
            } catch (err) {
                toast('ログインできませんでした: ' + (err.message || err));
            }
            return;
        }
        auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
            .catch(err => toast('ログインできませんでした: ' + err.message));
    }
    function cloudLogout() {
        if (!auth) return;
        if (isNativeApp()) { state.settings.cloudAutoLogin = false; save(); }
        auth.signOut();
    }

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
            let [label, cls] = map[cloudState] || ['', ''];
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
    // Android アプリ版との連携（Capacitor）
    //   アプリの中で開いたときだけ、計測と連動して
    //   画面の固定・通知欄のストップウォッチを動かす。ブラウザでは何もしない。
    // ════════════════════════════════════════════════════════
    const isNativeApp = () => !!(window.Capacitor && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform());
    function focusPlugin() {
        if (!isNativeApp()) return null;
        const P = Capacitor.Plugins && Capacitor.Plugins.Focus;
        if (P) return P;
        return typeof Capacitor.registerPlugin === 'function' ? Capacitor.registerPlugin('Focus') : null;
    }
    let nativeSig = '';          // 前回 Android に伝えた状態
    let nativeWasRunning = false;
    function syncNative() {
        const Focus = focusPlugin();
        if (!Focus) return;
        const t = state.timer;
        const task = t.taskId && state.tasks.find(x => x.id === t.taskId);
        const st = !task ? 'idle' : t.isRunning ? 'running' : (t.accumulatedSeconds > 0 ? 'paused' : 'idle');
        const sec = elapsed();
        const startedAt = Math.round(Date.now() - sec * 1000);
        // 一時停止中は表示する秒数が変わらないので、状態とタスクが同じなら送り直さない
        const sig = `${st}|${task ? task.id : ''}|${task ? task.text : ''}|${st === 'paused' ? sec : ''}`;
        if (sig === nativeSig) return;
        // 計測中は必ず画面を固定する（計測を始めたとき・計測中にアプリを開き直したとき）
        const firstCall = nativeSig === '';
        const startLock = st === 'running' && (!nativeWasRunning || firstCall);
        nativeSig = sig;
        nativeWasRunning = st === 'running';
        Focus.update({ state: st, title: task ? task.text : '', startedAt, elapsedText: fmtTimer(sec), startLock })
            .catch(e => console.warn('[focus]', e));
    }

    // ── ほかのアプリの通知（画面の固定中でもアプリ内で確認できるように） ──
    function notifPlugin() {
        if (!isNativeApp()) return null;
        const P = Capacitor.Plugins && Capacitor.Plugins.Notif;
        if (P) return P;
        return typeof Capacitor.registerPlugin === 'function' ? Capacitor.registerPlugin('Notif') : null;
    }
    const NOTIF_SEEN_KEY = 'daily_flow_notif_seen';
    let nativeNotifs = { enabled: false, connected: false, items: [] };
    let notifSeenAt = Number(localStorage.getItem(NOTIF_SEEN_KEY) || 0);
    const unreadNotifs = () => nativeNotifs.items.filter(n => n.time > notifSeenAt);

    let lastNotifSig = '';
    function applyNotifs(data) {
        if (!data) return;
        // 5秒ごとの確認で中身が変わっていなければ描き直さない（一覧のスクロール位置を保つ）
        const sig = JSON.stringify([!!data.enabled, !!data.connected, (data.items || []).map(n => [n.key, n.time, n.title, n.text])]);
        if (sig === lastNotifSig) return;
        lastNotifSig = sig;
        nativeNotifs = { enabled: !!data.enabled, connected: !!data.connected, items: data.items || [] };
        renderBell();
        renderNowBar();
        if ($('notifs-dialog').open) renderNotifList();
    }
    async function refreshNotifs() {
        const N = notifPlugin();
        if (!N || typeof N.getNotifications !== 'function') return;
        try { applyNotifs(await N.getNotifications()); } catch (e) { /* 古い版のアプリ */ }
    }
    function initNotifs() {
        const N = notifPlugin();
        if (!N || typeof N.getNotifications !== 'function') return;
        refreshNotifs();
        try { N.addListener('change', applyNotifs); } catch (e) { console.warn('[notif]', e); }
        // 変化の知らせが届かない場合に備えて、計測中・一覧を開いているときは5秒ごとにも確認する
        setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            if (state.timer.taskId || $('notifs-dialog').open) refreshNotifs();
        }, 5000);
    }
    // ── 音楽アプリ（Spotify・Amazon Music）の操作。固定中でもアプリを切り替えずに使える ──
    function mediaPlugin() {
        if (!isNativeApp()) return null;
        const P = Capacitor.Plugins && Capacitor.Plugins.Media;
        if (P) return P;
        return typeof Capacitor.registerPlugin === 'function' ? Capacitor.registerPlugin('Media') : null;
    }
    let nativeMedia = { enabled: false, items: [] };
    let lastMediaSig = '';
    function applyMedia(data) {
        if (!data) return;
        const items = Array.isArray(data.items) ? data.items : [];
        const sig = JSON.stringify([!!data.enabled, items.map(m => [m.pkg, m.title, m.artist, !!m.playing, !!m.active, !!m.canPrev, !!m.canNext])]);
        if (sig === lastMediaSig) return;
        lastMediaSig = sig;
        nativeMedia = { enabled: !!data.enabled, items };
        renderNowBar();
    }
    async function refreshMedia() {
        const M = mediaPlugin();
        if (!M || typeof M.getMedia !== 'function') return;
        try { applyMedia(await M.getMedia()); } catch (e) { /* 古い版のアプリ */ }
    }
    function initMedia() {
        const M = mediaPlugin();
        if (!M || typeof M.getMedia !== 'function') return;
        refreshMedia();
        try { M.addListener('change', applyMedia); } catch (e) { console.warn('[media]', e); }
        // 変化の知らせが届かない場合に備えて、計測中は5秒ごとにも確認する
        setInterval(() => {
            if (document.visibilityState === 'visible' && state.timer.taskId) refreshMedia();
        }, 5000);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshMedia(); });
    }
    const mediaStarting = {};   // 裏で再生を始めている途中のアプリ（pkg → 開始時刻）
    async function mediaControl(pkg, action) {
        const M = mediaPlugin();
        if (!M || typeof M.control !== 'function') return;
        const m = nativeMedia.items.find(x => x.pkg === pkg);
        if (m && !m.active) {
            // 止まっているアプリ: 裏で起動して、前回の続きから再生してもらう
            if (mediaStarting[pkg]) return;
            mediaStarting[pkg] = Date.now();
            lastMediaSig = ''; renderNowBar();
            try { await M.control({ pkg, action: 'play' }); }
            catch (e) {
                delete mediaStarting[pkg]; lastMediaSig = ''; renderNowBar();
                toast(e && e.message ? e.message : '再生を始められませんでした');
                return;
            }
            // 再生が始まったか、少しずつ間をあけて確かめる
            for (const wait of [800, 1500, 2500, 4000]) {
                await new Promise(r => setTimeout(r, wait));
                await refreshMedia();
                const now = nativeMedia.items.find(x => x.pkg === pkg);
                if (now && now.playing) break;
            }
            const now = nativeMedia.items.find(x => x.pkg === pkg);
            delete mediaStarting[pkg]; lastMediaSig = ''; renderNowBar();
            if (!now || !now.playing) {
                toast(`${m.app} が再生を始めませんでした。一度計測を一時停止して ${m.app} を開き、再生してから戻ってください（次からはここで操作できます）`);
            }
            return;
        }
        // 押した感触を出すため、再生・一時停止はすぐ表示を切り替える
        if (action === 'toggle' && m) { m.playing = !m.playing; lastMediaSig = ''; renderNowBar(); }
        try { await M.control({ pkg, action }); }
        catch (e) { toast(e && e.message ? e.message : '操作できませんでした'); }
        setTimeout(refreshMedia, 500);
    }
    function mediaHtml() {
        if (!isNativeApp() || !nativeMedia.items.length) return '';
        return `<div class="now-media">${nativeMedia.items.map(m => {
            const starting = !!mediaStarting[m.pkg];
            const status = starting ? '・起動中…' : !m.active ? '・停止中' : m.playing ? '' : '・一時停止中';
            const title = m.active && m.title
                ? `${esc(m.title)}${m.artist ? ` <span class="nm-artist">— ${esc(m.artist)}</span>` : ''}`
                : `<span class="nm-artist">${starting ? '再生を始めています' : '▶ で前回の続きを再生'}</span>`;
            return `
            <div class="nm-item ${m.active ? '' : 'idle'}">
                <div class="nm-info">
                    <span class="nm-app">🎵 ${esc(m.app)}${status}</span>
                    <span class="nm-title">${title}</span>
                </div>
                <div class="nm-btns">
                    <button type="button" class="nm-btn" data-act="media" data-pkg="${esc(m.pkg)}" data-cmd="prev" aria-label="前の曲" ${m.canPrev ? '' : 'disabled'}>⏮</button>
                    <button type="button" class="nm-btn main" data-act="media" data-pkg="${esc(m.pkg)}" data-cmd="toggle" aria-label="${m.playing ? '一時停止' : '再生'}" ${starting ? 'disabled' : ''}>${m.playing ? '⏸' : '▶'}</button>
                    <button type="button" class="nm-btn" data-act="media" data-pkg="${esc(m.pkg)}" data-cmd="next" aria-label="次の曲" ${m.canNext ? '' : 'disabled'}>⏭</button>
                </div>
            </div>`;
        }).join('')}</div>`;
    }

    function renderBell() {
        const btn = $('btn-notifs');
        if (!btn) return;
        btn.hidden = !(isNativeApp() && nativeNotifs.enabled);
        const n = unreadNotifs().length;
        const badge = $('bell-badge');
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.classList.toggle('on', n > 0);
    }
    function relTime(ms) {
        const m = Math.round((Date.now() - ms) / 60000);
        if (m < 1) return 'たった今';
        if (m < 60) return `${m}分前`;
        const h = Math.floor(m / 60);
        return h < 24 ? `${h}時間前` : `${Math.floor(h / 24)}日前`;
    }
    // 通知1件の表示。タップで全文を開閉し、全文の下の「アプリで開く」で通知元のアプリへ
    let expandedNotif = '';
    function notifItemHtml(n) {
        const open = expandedNotif === n.key;
        const openLabel = state.timer.isRunning ? 'アプリで開く（計測を一時停止）' : 'アプリで開く';
        return `<li class="n-item ${open ? 'open' : ''} ${n.time > notifSeenAt ? 'new' : ''}">
            <button type="button" class="n-main" data-act="notif-toggle" data-key="${esc(n.key)}" aria-expanded="${open}">
                <span class="n-head"><span>${esc(n.app)}</span><span>${relTime(n.time)}</span></span>
                ${n.title ? `<span class="n-title">${esc(n.title)}</span>` : ''}
                ${n.text ? `<span class="n-text">${esc(n.text)}</span>` : ''}
            </button>
            ${open ? `<button type="button" class="btn secondary small n-open" data-act="notif-open" data-key="${esc(n.key)}">${openLabel}</button>` : ''}
        </li>`;
    }
    function toggleNotif(key) {
        expandedNotif = expandedNotif === key ? '' : key;
        markNotifsSeen();
        renderNowBar();
        if ($('notifs-dialog').open) renderNotifList();
    }
    function markNotifsSeen() {
        notifSeenAt = Date.now();
        try { localStorage.setItem(NOTIF_SEEN_KEY, String(notifSeenAt)); } catch (e) { /* ignore */ }
        renderBell();
    }
    function renderNotifList() {
        const items = nativeNotifs.items;
        $('notifs-sub').textContent = items.length ? 'タップすると全文を表示します' : '通知はありません';
        $('notifs-list').innerHTML = items.map(notifItemHtml).join('');
    }
    // 通知の一覧を開く（読むだけなら計測は止めない）
    function openNotifs() {
        renderNotifList();
        markNotifsSeen(); renderNowBar();
        $('notifs-dialog').showModal();
    }
    // 通知元のアプリを開く: 計測中なら一時停止して画面の固定を解除してから開く
    async function openNotification(key) {
        const N = notifPlugin();
        if (!N) return;
        const t = state.timer;
        if (t.taskId && t.isRunning) {
            toggleTimer(t.taskId);
            toast('通知元のアプリを開くため、計測を一時停止しました');
            await new Promise(r => setTimeout(r, 700)); // 固定の解除を待つ
        }
        try {
            await N.open({ key });
            expandedNotif = '';
            if ($('notifs-dialog').open) $('notifs-dialog').close();
        } catch (e) { toast(e.message || '通知を開けませんでした'); refreshNotifs(); }
    }

    // ── 画面の固定を自分で解除したら、自動で一時停止 ──
    // （固定中は通知欄を開けないので、解除するのはたいてい通知を見るため）
    // 固定の確認（Android の「アプリを固定しますか？」）は計測を始めたときの1回だけ出す。
    // 「いいえ」を押したなど、しばらく待っても固定されなければ、固定なしで計測が進まないよう一時停止する
    let pinSeen = false, notPinnedSince = 0;
    const PIN_WAIT_MS = 15000;
    setInterval(async () => {
        const Focus = focusPlugin();
        const t = state.timer;
        if (!Focus || typeof Focus.getState !== 'function' || !t.isRunning) { pinSeen = false; notPinnedSince = 0; return; }
        try {
            const r = await Focus.getState();
            if (r.pinned) { pinSeen = true; notPinnedSince = 0; return; }
            if (!pinSeen) {
                if (!notPinnedSince) notPinnedSince = Date.now();
                if (Date.now() - notPinnedSince >= PIN_WAIT_MS && state.timer.isRunning) {
                    notPinnedSince = 0;
                    toggleTimer(state.timer.taskId);
                    toast('画面が固定されなかったので、計測を一時停止しました。「再開」でもう一度固定します');
                }
                return;
            }
            if (pinSeen && state.timer.isRunning) {
                pinSeen = false;
                toggleTimer(state.timer.taskId);
                toast('画面の固定が解除されたので、計測を一時停止しました');
            }
        } catch (e) { /* ignore */ }
    }, 2000);

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
        syncNative();
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
                return `<li class="${cls}"><span class="time">${e.allDay ? '終日' : esc(e.start + '〜' + e.end)}</span><span>${esc(e.title)}</span></li>`;
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
            : isNativeApp() ? (nativeNeedsConsent ? 'Google：「Googleと同期」で許可し直してください' : 'Google 未接続（「Googleと同期」で許可）')
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
                    <p><a href="${esc(url)}" target="_blank" rel="noopener">${apiLabel[k]} を有効にする ↗</a>（有効にしてから数分待って「Googleと同期」）</p></div>`;
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
                <button type="button" class="btn secondary" data-act="timer" data-id="${esc(task.id)}">${t.isRunning ? '一時停止' : '再開'}</button>
                ${t.isRunning ? '' : `<button type="button" class="btn secondary" data-act="discard" data-id="${esc(task.id)}">破棄</button>`}
                <button type="button" class="btn primary" data-act="finish">完了して記録</button>
            </div>${mediaHtml()}${notifPreviewHtml()}`;
    }
    function notifPreviewHtml() {
        if (!isNativeApp()) return '';
        const N = notifPlugin();
        if (!N || typeof N.getNotifications !== 'function') return '';
        if (!nativeNotifs.enabled) {
            // 許可がないと、固定中にほかのアプリの通知を見られないことを知らせる
            return `<button type="button" class="now-notif" data-act="notif-setup">
                <span>🔔</span><span class="nn-text">固定中にほかのアプリの通知を見たり、音楽を操作したりするには、通知へのアクセスの許可が必要です</span>
                <span class="nn-act">設定</span></button>`;
        }
        if (!nativeNotifs.connected) {
            return `<div class="now-notif"><span>🔔</span><span class="nn-text">通知の読み取りを準備しています…</span></div>`;
        }
        // 届いている通知を新しい順に一覧で表示（読むだけなら計測は止まらない）
        const items = nativeNotifs.items;
        if (!items.length) return '';
        const MAX = 5;
        const un = unreadNotifs().length;
        return `<div class="now-notifs">
            <div class="nn-bar"><span>🔔 通知 ${items.length}件${un ? `<span class="nn-new">新着 ${un}</span>` : ''}</span>
                ${items.length > MAX ? `<button type="button" class="link-btn" data-act="notifs">すべて見る</button>` : ''}</div>
            <ul class="notifs-list compact">${items.slice(0, MAX).map(notifItemHtml).join('')}</ul>
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
        if (task.date < d) meta.push(`<span class="chip old">${esc(String(task.date).substring(5).replace('-', '/'))}から</span>`);
        if (task.duration) meta.push(`<span>🕒 ${esc(task.duration)}分</span>`);
        if (sec && !running) meta.push(`<span class="paused-log">⏸ ${fmtTimer(sec)}<button type="button" class="link-btn" data-act="discard" data-id="${esc(task.id)}">破棄</button></span>`);
        return `
            <li class="task ${task.completed ? 'done' : ''} ${running ? 'running' : ''}">
                <button type="button" class="check ${task.completed ? 'on' : ''}" data-act="toggle" data-id="${esc(task.id)}" aria-label="完了"></button>
                <div class="task-body">
                    <div class="task-name">${esc(task.text)}</div>
                    ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
                </div>
                ${task.completed ? '' : `<button type="button" class="play ${running ? 'on' : ''}" data-act="timer" data-id="${esc(task.id)}" aria-label="${running ? '一時停止' : '計測開始'}">${running ? '❚❚' : '▶'}</button>`}
                <button type="button" class="del" data-act="delete" data-id="${esc(task.id)}" aria-label="削除">×</button>
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
            <li data-id="${esc(r.id)}" class="${rSelected.has(r.id) ? 'selected' : ''}">
                <input type="checkbox" class="r-check" data-id="${esc(r.id)}" ${rSelected.has(r.id) ? 'checked' : ''} aria-label="選択">
                <div class="r-move">
                    <button type="button" data-act="r-up" data-id="${esc(r.id)}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">▲</button>
                    <button type="button" data-act="r-down" data-id="${esc(r.id)}" ${i === rDraft.length - 1 ? 'disabled' : ''} aria-label="下へ">▼</button>
                </div>
                <input type="text" class="r-name" data-id="${esc(r.id)}" value="${esc(r.text)}" aria-label="タスク名">
                <label class="r-min"><input type="number" class="r-dur" data-id="${esc(r.id)}" min="0" max="1440" value="${esc(r.duration || '')}" placeholder="—" aria-label="時間（分）">分</label>
                <div class="r-status">${status}</div>
                <button type="button" class="del" data-act="r-remove" data-id="${esc(r.id)}" aria-label="削除">×</button>
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
        if (o && o.skipDate === d) return `<span class="chip">今日はお休み</span><button type="button" class="link-btn" data-act="r-unskip" data-id="${esc(r.id)}">今日も出す</button>`;
        if (o) return `<button type="button" class="link-btn" data-act="r-skip" data-id="${esc(r.id)}">今日は休む</button>`;
        return '';
    }

    // 1行の状態表示だけ更新（一覧全体を描き直さないので、入力中のフォーカスが外れない）
    function updateRoutineRow(id) {
        const li = document.querySelector(`#routine-list li[data-id="${esc(id)}"]`);
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
                case 'notifs': openNotifs(); break;
                case 'notif-setup': $('btn-settings').click(); setTimeout(() => { const el = $('listener-status'); if (el) el.scrollIntoView({ block: 'center' }); }, 100); break;
                case 'close-notifs': $('notifs-dialog').close(); break;
                case 'notif-open': openNotification(el.dataset.key); break;
                case 'notif-toggle': toggleNotif(el.dataset.key); break;
                case 'media': mediaControl(el.dataset.pkg, el.dataset.cmd); break;
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
            if (task.date > today()) toast(`「${task.text}」を ${esc(String(task.date).substring(5).replace('-', '/'))} に追加しました`);
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
            $('app-settings').hidden = !isNativeApp();
            if (isNativeApp()) { refreshNotifStatus(); refreshListenerStatus(); }
            const gas = state.settings.gas || state.settings.gasDraft || {};
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
        // ── 通知の確認（アプリ版） ──
        const notifCall = async (method) => {
            const Focus = focusPlugin();
            if (!Focus) throw new Error('Android との連携が見つかりません');
            if (typeof Focus[method] !== 'function') throw new Error('OLD_APP');
            return Focus[method]();
        };
        const showNotif = (r) => {
            const el = $('notif-status');
            if (!r) return;
            if (r.enabled && r.channelEnabled !== false) {
                el.textContent = '✓ 通知は許可されています。計測中は通知欄に経過時間が出ます。';
            } else if (r.enabled) {
                el.textContent = '✕ 「計測中のタイマー」の通知がオフになっています。「通知の設定を開く」からオンにしてください。';
            } else {
                el.textContent = '✕ 通知が許可されていません。「通知を許可する」を押してください（出てこない場合は「通知の設定を開く」からオンに）。';
            }
        };
        const notifError = (e) => {
            $('notif-status').textContent = e.message === 'OLD_APP' || /not implemented/i.test(e.message || '')
                ? 'この機能を使うには、アプリを新しい版に更新してください（Releases から daily-flow.apk を入れ直す）。'
                : '✕ ' + (e.message || '通知の状態を確認できませんでした');
        };
        async function refreshNotifStatus() {
            try { showNotif(await notifCall('checkNotifications')); } catch (e) { notifError(e); }
        }
        $('btn-notif-allow').addEventListener('click', async () => {
            try {
                const r = await notifCall('requestNotifications');
                showNotif(r);
                if (!r.enabled) toast('許可の確認が出ない場合は「通知の設定を開く」からオンにしてください');
            } catch (e) { notifError(e); }
        });
        $('btn-notif-test').addEventListener('click', async () => {
            try {
                const r = await notifCall('testNotification');
                showNotif(r);
                toast(r.enabled ? 'テスト通知を出しました。通知欄を確認してください' : '通知が許可されていないため出せません');
            } catch (e) { notifError(e); }
        });
        $('btn-notif-settings').addEventListener('click', async () => {
            try { await notifCall('openNotificationSettings'); } catch (e) { notifError(e); }
        });
        // ほかのアプリの通知を読み取る許可
        async function refreshListenerStatus() {
            const N = notifPlugin();
            const el = $('listener-status');
            if (!N || typeof N.getNotifications !== 'function') {
                el.textContent = 'この機能を使うには、アプリを新しい版に更新してください（Releases から daily-flow.apk を入れ直す）。';
                return;
            }
            try {
                const r = await N.getNotifications();
                applyNotifs(r);
                el.textContent = r.enabled
                    ? `✓ 許可されています（今ある通知 ${r.items.length} 件）`
                    : '✕ まだ許可されていません。「通知へのアクセスを許可」を押し、Daily Flow をオンにしてください。オンにできない（「制限付き設定」と出る）ときは、「アプリ情報を開く」→ 右上の︙ →「制限付き設定を許可」をしてから、もう一度試してください。';
            } catch (e) { el.textContent = '✕ ' + (e.message || '状態を確認できませんでした'); }
        }
        $('btn-listener-allow').addEventListener('click', async () => {
            const N = notifPlugin();
            try { await N.openAccessSettings(); } catch (e) { toast(e.message || '設定画面を開けませんでした'); }
        });
        $('btn-listener-appinfo').addEventListener('click', async () => {
            const N = notifPlugin();
            try { await N.openAppInfo(); } catch (e) { toast(e.message || 'アプリ情報を開けませんでした'); }
        });

        // 通知の設定画面から戻ってきたら、状態を確認し直す
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && isNativeApp()) {
                refreshNotifs();
                if ($('settings-dialog').open) { refreshNotifStatus(); refreshListenerStatus(); }
            }
        });

        // 入力途中のURL・合言葉は、接続テスト前でも保存しておく（設定を閉じても消えない）
        ['gas-url', 'gas-key'].forEach(id => $(id).addEventListener('input', () => {
            state.settings.gasDraft = { url: $('gas-url').value.trim(), key: $('gas-key').value.trim().replace(/^合言葉[:：]\s*/, '') };
            save();
        }));
        $('btn-gas-save').addEventListener('click', async () => {
            // 「合言葉: xxxx」と行ごと貼られても読めるようにする
            const url = $('gas-url').value.trim(), key = $('gas-key').value.trim().replace(/^合言葉[:：]\s*/, '');
            $('gas-key').value = key;
            if (!key) { toast('合言葉を入れてください'); return; }
            if (!validGasUrl(url)) {
                toast('URLは https://script.google.com/macros/s/…/exec の形です'); return;
            }
            const prev = state.settings.gas;
            state.settings.gas = { url, key };
            renderGasStatus('接続テスト中…');
            try {
                await gasCall('ping');
                state.settings.gasDraft = null;
                save();
                renderGasStatus();
                toast('自動ログインを設定しました');
                busy = false; // 前の読み込みが止まっていても、すぐ読み込み直す
                syncAll();
            } catch (e) {
                state.settings.gas = prev;
                renderGasStatus('✕ ' + e.message);
            }
        });
        // 入力中のURLと合言葉で、スクリプトの応答をブラウザで直接開く（原因の切り分け用）
        $('btn-gas-open').addEventListener('click', () => {
            const url = $('gas-url').value.trim(), key = $('gas-key').value.trim().replace(/^合言葉[:：]\s*/, '');
            if (!url || !key) { toast('URLと合言葉を入れてください'); return; }
            // 中継スクリプトのアドレス以外は開かない（javascript: などを入れられても実行しない）
            if (!validGasUrl(url)) { toast('URLは https://script.google.com/macros/s/…/exec の形です'); return; }
            window.open(`${url}${url.includes('?') ? '&' : '?'}action=ping&key=${encodeURIComponent(key)}`, '_blank', 'noopener');
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
            // 中継スクリプトの合言葉はファイルに書き出さない（ファイルが人の手に渡っても使われないように）
            const out = JSON.parse(JSON.stringify(state));
            if (out.settings) { delete out.settings.gas; delete out.settings.gasDraft; }
            const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
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
                // 接続先（同期先・中継スクリプト・OAuth）は今の設定のままにする。
                // 細工されたファイルを読み込んでも、データが他人の所へ送られないように。
                const cur = state.settings || {};
                data.settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
                ['firebaseConfig', 'gas', 'gasDraft', 'clientId'].forEach(k => {
                    if (cur[k] !== undefined) data.settings[k] = cur[k]; else delete data.settings[k];
                });
                localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                load(); render(); dlg.close(); toast('復元しました');
                // 復元した設定に中継スクリプトがあれば、すぐ予定とToDoを読み込む
                busy = false;
                if (googleReady()) syncAll();
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
    initNotifs();
    initMedia();
    // 中継スクリプトがあれば、開いた時点で自動で読み込む（ログイン不要）
    if (googleReady()) setTimeout(() => syncAll(), 300);
    // アプリ版: 端末間同期にまだログインしていなければ、Google の許可を使って自動でログインする
    if (isNativeApp() && state.settings.nativeGoogle) {
        setTimeout(() => {
            if (auth && !currentUser && state.settings.cloudAutoLogin !== false) {
                nativeLoginToken(false)
                    .then(at => auth.signInWithCredential(firebase.auth.GoogleAuthProvider.credential(null, at)))
                    .catch(e => console.warn('[cloud] auto login', e));
            }
        }, 2500);
    }
    else armAutoConnect();
    // 1時間で接続が切れるので、切れたら次の操作でつなぎ直す
    setInterval(armAutoConnect, 30000);

    // Googleログイン用のスクリプトは、ブラウザで使うときだけ読み込む
    // （アプリ版はスマホのGoogleアカウントを使うので不要。外部のコードを減らす）
    if (!isNativeApp()) {
        const gsi = document.createElement('script');
        gsi.src = 'https://accounts.google.com/gsi/client';
        gsi.async = true;
        document.head.appendChild(gsi);
    }
    if ('serviceWorker' in navigator) {
        const reg = () => navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW registration failed:', err));
        if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg);
    }

    // テスト用
    window.__df = { notifs: () => nativeNotifs, nativeSig: () => nativeSig, state: () => state, cleanRoutines, showView, routineChanges, draft: () => rDraft, isRecordDue, recordDateTimes, parseInput, syncAll, finishTimer, toggleTimer };
})();
