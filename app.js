/**
 * Daily Flow (v3 — 最小構成)
 *
 * できること:
 *   - 今日のタスク: 1行で追加（「60分」「明日」「毎日」を書ける）、完了、削除、未完了は翌日へ繰り越し
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
        rollover();
    }

    function save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
        catch (e) { toast('保存に失敗しました: ' + e.message); }
        scheduleCloudSave();
    }

    // 日付が変わったら: 完了済みを片付け、未完了は残し、毎日のタスクを作り直す
    function rollover() {
        const d = today();
        if (state.lastDate === d) return false;
        // 毎日のタスクは今日の分だけ残し、足りない分を作る（何度呼んでも重複しない）
        const keep = state.tasks.filter(t => t.id === state.timer.taskId ||
            (t.isRoutine ? t.date === d : (!t.completed || t.date >= d)));
        const routineTasks = state.routines
            .filter(r => !keep.some(t => t.isRoutine && t.date === d && t.text === r.text))
            .map(r => ({
            id: genId(), text: r.text, duration: r.duration || 0, tag: r.tag || 'タスク',
            date: d, completed: false, isRoutine: true
        }));
        state.tasks = [...keep, ...routineTasks];
        state.lastDate = d;
        save();
        return true;
    }

    // ════════════════════════════════════════════════════════
    // タスク
    // ════════════════════════════════════════════════════════
    // 「レポート 60分 明日」→ { text, duration, date, routine }
    function parseInput(raw) {
        let text = ' ' + raw + ' ';
        let duration = 0, date = today(), routine = false, m;
        if ((m = text.match(/\s(\d+(?:\.\d+)?)\s*(時間|h)(?=\s)/i))) {
            duration = Math.round(parseFloat(m[1]) * 60); text = text.replace(m[0], ' ');
        } else if ((m = text.match(/\s(\d+)\s*(分|m|min)(?=\s)/i))) {
            duration = parseInt(m[1], 10); text = text.replace(m[0], ' ');
        }
        if (/\s毎日(?=\s)/.test(text)) { routine = true; text = text.replace(/\s毎日(?=\s)/, ' '); }
        else if (/\s明日(?=\s)/.test(text)) { date = addDays(today(), 1); text = text.replace(/\s明日(?=\s)/, ' '); }
        else if (/\s今日(?=\s)/.test(text)) { text = text.replace(/\s今日(?=\s)/, ' '); }
        text = text.replace(/\s+/g, ' ').trim() || raw.trim();
        return { text, duration, date, routine };
    }

    function addTask(raw, extra = {}) {
        const p = parseInput(raw);
        if (!p.text) return null;
        const task = {
            id: genId(), text: p.text, duration: p.duration, tag: 'タスク',
            date: p.routine ? today() : p.date, completed: false, isRoutine: p.routine, ...extra
        };
        state.tasks.push(task);
        if (p.routine && !state.routines.some(r => r.text === p.text)) {
            state.routines.push({ id: genId(), text: p.text, duration: p.duration, tag: 'タスク' });
        }
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
        save(); render();
    }

    function deleteTask(id) {
        const task = state.tasks.find(t => t.id === id);
        if (!task) return;
        if (task.isRoutine && !confirm(`「${task.text}」は毎日のタスクです。明日以降も出さないようにしますか？`)) return;
        if (task.isRoutine) state.routines = state.routines.filter(r => r.text !== task.text);
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

    function connect() {
        return new Promise((resolve, reject) => {
            if (!window.google || !google.accounts || !google.accounts.oauth2) {
                reject(new Error('Googleのログイン用スクリプトを読み込めませんでした。通信状態を確認してください。'));
                return;
            }
            const client = google.accounts.oauth2.initTokenClient({
                client_id: state.settings.clientId,
                scope: SCOPE,
                callback: resp => {
                    if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
                    token = { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
                    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch (e) { /* ignore */ }
                    resolve();
                },
                error_callback: err => reject(new Error((err && err.message) || 'ログインがキャンセルされました'))
            });
            client.requestAccessToken({ prompt: '' });
        });
    }

    function disconnect() {
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
            let msg = String(res.status);
            try { const j = await res.json(); msg += ' ' + ((j.error && j.error.message) || ''); } catch (e) { /* ignore */ }
            throw new Error(msg);
        }
        return res.status === 204 ? null : res.json();
    }

    // Google ToDo → タスク
    async function pullGoogleTasks() {
        const g = state.settings.gsync;
        const d = today();
        const updatedMin = new Date(Date.now() - 60 * 86400000).toISOString();
        const lists = await api(`${TASKS_API}/users/@me/lists?maxResults=100`);
        const seen = new Set();
        for (const list of (lists.items || [])) {
            let pageToken = '';
            do {
                const q = new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100', updatedMin });
                if (pageToken) q.set('pageToken', pageToken);
                const res = await api(`${TASKS_API}/lists/${encodeURIComponent(list.id)}/tasks?${q}`);
                for (const gt of (res.items || [])) {
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
                pageToken = res.nextPageToken || '';
            } while (pageToken);
        }
        // Google 側で消えた未完了タスクは外す（計測中・一時停止中のものは残す）
        state.tasks = state.tasks.filter(t => !t.gtaskId || t.completed || seen.has(t.gtaskId)
            || t.id === state.timer.taskId || state.pausedTimers.some(p => p.taskId === t.id));
    }

    // カレンダー → 今日の予定（表示のみ）
    async function pullCalendarEvents() {
        const g = state.settings.gsync;
        const d = today();
        const [y, m, dd] = d.split('-').map(Number);
        const timeMin = new Date(y, m - 1, dd, 0, 0).toISOString();
        const timeMax = new Date(y, m - 1, dd + 1, DAY_BOUNDARY_HOUR, 0).toISOString();
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
        items.sort((a, b) => a.allDay !== b.allDay ? (a.allDay ? -1 : 1) : (a.startDate + a.start).localeCompare(b.startDate + b.start));
        g.todayEvents = { date: d, items };
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

    let busy = false, syncError = '';
    async function syncAll({ interactive = false } = {}) {
        if (busy) return;
        busy = true; syncError = ''; renderSchedule();
        try {
            if (!tokenValid()) {
                if (!interactive) return;
                await connect();
            }
            const g = state.settings.gsync;
            if (!g.since) g.since = today();
            await pullCalendarEvents();
            try { await pullGoogleTasks(); }
            catch (e) {
                if (e.message === 'NO_TOKEN') throw e;
                console.warn('[tasks]', e);
                syncError = 'Google ToDo を読めませんでした（Google Tasks API が有効か確認してください）';
            }
            const pushed = await pushRecords();
            if (pushed) toast(`実績 ${pushed} 件を「${REC_CAL_NAME}」に登録しました`);
            g.lastSyncAt = Date.now();
            save();
        } catch (e) {
            if (e.message !== 'NO_TOKEN') { console.error('[sync]', e); syncError = '同期に失敗しました: ' + e.message; }
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

            // 実績・毎日のタスク: 両方を合わせる（同じIDはクラウド優先）
            state.schedules = unionById(c.schedules || [], state.schedules);
            state.routines = unionById(c.routines || [], state.routines)
                .filter((r, i, arr) => arr.findIndex(x => x.text === r.text) === i);

            // 設定: クラウドを基本に、Google ToDo の完了済みIDは両方を合わせる
            const localDone = state.settings.gsync.doneGtaskIds || [];
            const localEvents = state.settings.gsync.todayEvents;
            state.settings = { ...state.settings, ...(c.settings || {}) };
            if (!state.settings.gsync) state.settings.gsync = {};
            const g = state.settings.gsync;
            g.doneGtaskIds = Array.from(new Set([...(g.doneGtaskIds || []), ...localDone])).slice(-500);
            if (localEvents && (!g.todayEvents || localEvents.date >= g.todayEvents.date)) g.todayEvents = localEvents;

            // タスク: 同じIDはクラウド優先、手元にしかないもの（未送信の追加分）は残す
            const cloudDate = c.lastDate || '';
            state.tasks = unionById(c.tasks || [], state.tasks)
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

            if (cloudDate < d) state.lastDate = cloudDate; // 日付が古ければ繰り越し処理をやり直す
            rollover();
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
                signedout: ['☁ 未ログイン', 'warn'],
                syncing: ['☁ 同期中…', ''],
                pending: [navigator.onLine ? '☁ 同期待ち' : '☁ オフライン', 'warn'],
                synced: ['☁ 同期済み', 'ok'],
                error: ['☁ 同期エラー', 'bad']
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

        const connected = tokenValid();
        const status = busy ? '同期中…'
            : connected ? (g.lastSyncAt ? `最終同期 ${hm(new Date(g.lastSyncAt))}` : '接続済み')
            : (g.lastSyncAt ? '再接続が必要です' : '未接続');

        $('schedule-panel').innerHTML = `
            <div class="panel-head">
                <h2>今日の予定</h2>
                <div class="head-actions">
                    <span class="muted small-text">${status}</span>
                    <button type="button" class="btn secondary small" data-act="sync" ${busy ? 'disabled' : ''}>⟳ Googleと同期</button>
                </div>
            </div>
            ${body}${rec}
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
                <button type="button" class="btn primary" data-act="finish">完了して記録</button>
            </div>`;
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
        if (sec && !running) meta.push(`<span>⏸ ${fmtTimer(sec)}</span>`);
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
                case 'carry': moveOverdueToToday(); break;
                case 'sync': syncAll({ interactive: true }); break;
                case 'cloud-login': cloudLogin(); break;
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
            dlg.showModal();
        };
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
            if (!busy && tokenValid() && pendingRecords().length) syncAll();
            else renderSchedule();
        }, 60000);

        // 画面に戻ってきたとき
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            if (rollover()) render();
            const g = state.settings.gsync;
            if (tokenValid() && (!g.lastSyncAt || Date.now() - g.lastSyncAt > 10 * 60000)) syncAll();
            // 他の端末での変更を取り込む（未送信の変更があるときは先に送る）
            if (currentUser && Date.now() - lastCloudFetch > 60000) {
                if (cloudSaveTimer) saveToCloud().then(fetchCloud); else fetchCloud();
            }
        });
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
    if (tokenValid()) setTimeout(() => syncAll(), 500);

    // テスト用
    window.__df = { state: () => state, isRecordDue, recordDateTimes, parseInput, syncAll, finishTimer, toggleTimer };
})();
