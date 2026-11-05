/**
 * Daily Flow — シンプルモード (v1)
 *
 * 目的: 使い続けられるように「今日のタスク」と「タイマー」だけを前面に出す。
 * 方針:
 *   - 既存機能・既存データは消さない（設定でいつでも元の全機能表示に戻せる）
 *   - app.js は変更せず、関数ラップと DOM への追加だけで実現する
 *   - state.settings.simpleMode が false でない限りシンプルモード（未設定=ON）
 *
 * 変更点:
 *   1. 入力はタイトル1行。「レポート 60分 明日 #勉強」のような省略記法を任意で使える
 *   2. 1日の負荷上限（初期値4件で登録を拒否）とタスク3件の表示上限をシンプルモードでは無効化
 *   3. 各タスクに ▶ ボタン。タップでタイマー開始、画面上部に計測中バー
 *   4. 前日までの残りタスクを1タップで今日に移すバナー
 *   5. 週目標・デイリーチェック・熱システム・テンプレ・AI などは非表示（データは保持）
 */
(function () {
    'use strict';

    // ── 判定 ───────────────────────────────────────────────
    function isSimple() {
        return !(state && state.settings && state.settings.simpleMode === false);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // ── スタイル ───────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        body.simple-mode [data-sm-advanced] { display: none !important; }
        body.simple-mode #add-task-form:not(.sm-show-detail) [data-sm-detail] { display: none !important; }
        .sm-detail-toggle {
            background: none; border: none; color: var(--text-secondary);
            font-size: 0.82rem; cursor: pointer; padding: 4px 0; margin: -0.25rem 0 0.6rem;
            text-decoration: underline; font-family: inherit;
        }
        body:not(.simple-mode) .sm-detail-toggle, body:not(.simple-mode) .sm-hint { display: none; }
        .sm-hint { font-size: 0.78rem; color: var(--text-secondary); margin: -0.4rem 0 0.6rem; }
        .sm-play {
            flex-shrink: 0; width: 34px; height: 34px; border-radius: 50%;
            border: 1px solid var(--primary-color); background: transparent;
            color: var(--primary-color); cursor: pointer; font-size: 0.85rem;
            display: flex; align-items: center; justify-content: center; margin-right: 4px;
        }
        .sm-play.running { background: var(--primary-color); color: #fff; }
        body.simple-mode .task-meta { flex-wrap: wrap; }
        body.simple-mode .task-meta > span { white-space: nowrap; }
        .sm-paused-time { font-size: 0.75rem; color: var(--text-secondary); }
        #sm-now {
            display: none; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 12px 14px;
            margin-bottom: 1rem; border-radius: var(--radius-md);
            background: rgba(249,115,22,0.10); border: 1px solid rgba(249,115,22,0.45);
        }
        #sm-now.visible { display: flex; }
        #sm-now .sm-now-name { flex: 1 1 100%; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #sm-now .sm-now-time { flex: 1; font-variant-numeric: tabular-nums; font-size: 1.15rem; font-weight: 700; }
        #sm-now button { padding: 6px 12px; font-size: 0.85rem; }
        #sm-carry {
            display: none; align-items: center; gap: 10px; padding: 10px 14px;
            margin-bottom: 1rem; border-radius: var(--radius-md);
            background: rgba(255,255,255,0.05); border: 1px solid var(--panel-border);
            font-size: 0.88rem; color: var(--text-secondary);
        }
        #sm-carry.visible { display: flex; }
        #sm-carry span { flex: 1; }
        #sm-carry button { padding: 5px 12px; font-size: 0.82rem; white-space: nowrap; }
        .sm-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
        .sm-settings-row input { width: 20px; height: 20px; flex-shrink: 0; }
    `;
    document.head.appendChild(style);

    // ── 非表示にする要素へ印を付ける ───────────────────────
    function markAdvanced() {
        const ids = [
            'weekly-goal-banner', 'daily-checkin-bar', 'thermal-dashboard',
            'btn-ai-breakdown', 'template-buttons', 'btn-ai-plan', 'ai-plan-output'
        ];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.setAttribute('data-sm-advanced', '');
        });

        // 負荷上限ボックス（#load-indicator の親）
        const load = document.getElementById('load-indicator');
        if (load && load.parentElement) load.parentElement.setAttribute('data-sm-advanced', '');

        // テンプレ保存ボタン行
        const saveTpl = document.getElementById('btn-save-template');
        if (saveTpl && saveTpl.parentElement) saveTpl.parentElement.setAttribute('data-sm-advanced', '');

        // 「テンプレート」「AIアシスト」の区切り線
        document.querySelectorAll('#view-dashboard .divider').forEach(d => {
            const t = d.textContent.trim();
            if (t === 'テンプレート' || t === 'AIアシスト') d.setAttribute('data-sm-advanced', '');
        });

        // サイドバー: 今日・タイマー・設定だけ残す
        const keep = ['dashboard', 'timer', 'settings'];
        document.querySelectorAll('.sidebar li[data-view]').forEach(li => {
            if (!keep.includes(li.dataset.view)) li.setAttribute('data-sm-advanced', '');
        });
        // スマホの「その他」メニュー: 設定だけ残す
        document.querySelectorAll('#mobile-more-list li[data-view]').forEach(li => {
            if (li.dataset.view !== 'settings') li.setAttribute('data-sm-advanced', '');
        });
    }

    // ── 入力フォーム: 詳細欄を折りたたみ、省略記法を受け付ける ───
    const form = document.getElementById('add-task-form');
    const nameInput = document.getElementById('task-name');
    const originalPlaceholder = nameInput ? nameInput.placeholder : '';

    function setupForm() {
        if (!form || !nameInput) return;

        // タグ/繰り返し、時間/負荷/日付 の2つのグリッドを「詳細」扱いにする
        Array.from(form.children).forEach(child => {
            if (child.style && child.style.display === 'grid') child.setAttribute('data-sm-detail', '');
        });

        const submitBtn = form.querySelector('button[type="submit"]');
        const hint = document.createElement('p');
        hint.className = 'sm-hint';
        hint.textContent = 'Enterで追加。必要なら「60分」「明日」「毎日」「#勉強」も書けます';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'sm-detail-toggle';
        toggle.textContent = '詳細を設定';
        toggle.addEventListener('click', () => {
            const open = form.classList.toggle('sm-show-detail');
            toggle.textContent = open ? '詳細を閉じる' : '詳細を設定';
        });
        if (submitBtn) {
            form.insertBefore(hint, submitBtn);
            form.insertBefore(toggle, submitBtn);
        }

        // capture 段階で先に省略記法を解釈し、既存の submit ハンドラにそのまま渡す
        form.addEventListener('submit', () => {
            if (!isSimple()) return;
            applyQuickSyntax();
        }, true);
    }

    const TAG_MAP = {
        '講義': '講義', '授業': '講義',
        '勉強': '勉強・課題', '課題': '勉強・課題', 'レポート': '勉強・課題',
        '趣味': '趣味・遊び', '遊び': '趣味・遊び',
        '運動': '運動', 'ジム': '運動'
    };

    function applyQuickSyntax() {
        let text = nameInput.value;
        const durEl = document.getElementById('task-duration');
        const routineEl = document.getElementById('task-routine');
        const tagEl = document.getElementById('task-tag');
        const dateEl = document.getElementById('task-date');

        // 所要時間: 60分 / 60m / 1.5h / 2時間
        let m = text.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(時間|h)(?=\s|$)/i);
        if (m) {
            if (durEl) durEl.value = Math.round(parseFloat(m[1]) * 60);
            text = text.replace(m[0], ' ');
        } else {
            m = text.match(/(?:^|\s)(\d+)\s*(分|m|min)(?=\s|$)/i);
            if (m) {
                if (durEl) durEl.value = parseInt(m[1], 10);
                text = text.replace(m[0], ' ');
            }
        }

        // 日付・繰り返し
        if (/(?:^|\s)毎日(?=\s|$)/.test(text)) {
            if (routineEl) routineEl.value = 'true';
            text = text.replace(/(?:^|\s)毎日(?=\s|$)/, ' ');
        } else if (/(?:^|\s)明日(?=\s|$)/.test(text)) {
            if (routineEl) routineEl.value = 'tomorrow';
            if (dateEl) dateEl.value = getTomorrowString();
            text = text.replace(/(?:^|\s)明日(?=\s|$)/, ' ');
        } else if (/(?:^|\s)今日(?=\s|$)/.test(text)) {
            text = text.replace(/(?:^|\s)今日(?=\s|$)/, ' ');
        }

        // タグ: #勉強 など
        m = text.match(/(?:^|\s)[#＃](\S+)/);
        if (m) {
            const tag = TAG_MAP[m[1]];
            if (tag && tagEl) {
                tagEl.value = tag;
                text = text.replace(m[0], ' ');
            }
        }

        text = text.replace(/\s+/g, ' ').trim();
        if (text) nameInput.value = text; // 記法だけで空になったら元の文字列を残す
    }

    // ── 負荷上限・3件表示上限をシンプルモードでは無効化 ──────
    const _origGetTodayLoad = getTodayLoad;
    getTodayLoad = function () {
        if (isSimple()) return 0;
        return _origGetTodayLoad.apply(this, arguments);
    };

    const _origApplyTaskCap = applyTaskCap;
    applyTaskCap = function () {
        if (isSimple()) return;
        return _origApplyTaskCap.apply(this, arguments);
    };

    // ── タイマー: タスクから直接開始 ───────────────────────
    function currentSeconds() {
        const t = state.timer;
        if (!t) return 0;
        let s = t.accumulatedSeconds || 0;
        if (t.isRunning && t.startTime) s += Math.floor((Date.now() - t.startTime) / 1000);
        return s;
    }

    function pauseTimer() {
        const t = state.timer;
        if (!t.isRunning) return;
        t.accumulatedSeconds += Math.floor((Date.now() - t.startTime) / 1000);
        t.isRunning = false;
        t.startTime = null;
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    }

    window.smToggleTaskTimer = function (taskId) {
        const t = state.timer;
        if (t.taskId === taskId) {
            if (t.isRunning) {
                pauseTimer();
            } else {
                t.isRunning = true;
                t.startTime = Date.now();
            }
            saveData();
            syncTimerUI();
        } else {
            // 別タスクに切り替え: 既存の一時停止リストに退避してから開始
            resumePausedTimer(taskId);
        }
        renderNowBar();
    };

    window.smFinishTimer = function () {
        const btn = document.getElementById('btn-timer-finish');
        if (btn) btn.click();
        renderNowBar();
    };

    function decorateTaskRows() {
        const list = document.getElementById('active-task-list');
        if (!list) return;
        list.querySelectorAll('.task-item').forEach(li => {
            if (li.querySelector('.sm-play')) return;
            const cb = li.querySelector('.task-checkbox');
            const m = cb && (cb.getAttribute('onclick') || '').match(/toggleTask\('([^']+)'\)/);
            if (!m) return;
            const id = m[1];
            // 負荷表示はシンプルモードでは使わないので消す
            li.querySelectorAll('.task-meta span').forEach(sp => {
                if (sp.textContent.includes('負荷')) sp.remove();
            });
            const running = state.timer.taskId === id && state.timer.isRunning;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sm-play' + (running ? ' running' : '');
            btn.title = running ? '一時停止' : 'タイマー開始';
            btn.textContent = running ? '❚❚' : '▶';
            btn.addEventListener('click', e => { e.stopPropagation(); window.smToggleTaskTimer(id); });

            // 一時停止中の計測時間を表示
            let paused = 0;
            if (state.timer.taskId === id && !state.timer.isRunning) paused = state.timer.accumulatedSeconds;
            const pt = (state.pausedTimers || []).find(p => p.taskId === id);
            if (pt) paused = pt.accumulatedSeconds;
            if (paused > 0) {
                const meta = li.querySelector('.task-meta');
                if (meta) {
                    const s = document.createElement('span');
                    s.className = 'sm-paused-time';
                    s.textContent = '⏸ ' + formatTimer(paused);
                    meta.appendChild(s);
                }
            }

            const del = li.querySelector('.btn-delete');
            li.insertBefore(btn, del || null);
        });
    }

    // ── 計測中バー・繰り越しバナー ─────────────────────────
    let nowBar = null;
    let carryBar = null;

    function setupBars() {
        const panel = document.querySelector('#view-dashboard .task-list-panel');
        if (!panel) return;

        nowBar = document.createElement('div');
        nowBar.id = 'sm-now';
        panel.insertBefore(nowBar, panel.firstChild);

        carryBar = document.createElement('div');
        carryBar.id = 'sm-carry';
        panel.insertBefore(carryBar, nowBar.nextSibling);

        setInterval(() => {
            if (!nowBar || !nowBar.classList.contains('visible')) return;
            const el = nowBar.querySelector('.sm-now-time');
            if (el) el.textContent = formatTimer(currentSeconds());
        }, 1000);
    }

    function renderNowBar() {
        if (!nowBar) return;
        const t = state.timer;
        const task = t && t.taskId ? state.tasks.find(x => x.id === t.taskId) : null;
        if (!isSimple() || !task || (!t.isRunning && !(t.accumulatedSeconds > 0))) {
            nowBar.classList.remove('visible');
            nowBar.innerHTML = '';
            return;
        }
        nowBar.classList.add('visible');
        nowBar.innerHTML = `
            <span class="sm-now-name">${t.isRunning ? '⏱ 計測中' : '⏸ 一時停止中'}：${esc(task.text)}</span>
            <span class="sm-now-time">${formatTimer(currentSeconds())}</span>
            <button type="button" class="btn secondary" onclick="smToggleTaskTimer('${task.id}')">${t.isRunning ? '一時停止' : '再開'}</button>
            <button type="button" class="btn primary" onclick="smFinishTimer()">完了</button>`;
    }

    function renderCarryBar() {
        if (!carryBar) return;
        const today = getTodayString();
        const old = state.tasks.filter(t => !t.completed && !t.isRoutine && t.date && t.date < today);
        if (!isSimple() || old.length === 0) {
            carryBar.classList.remove('visible');
            carryBar.innerHTML = '';
            return;
        }
        carryBar.classList.add('visible');
        carryBar.innerHTML = `
            <span>前日までの残りが ${old.length} 件あります（不要なものは🗑で消せます）</span>
            <button type="button" class="btn secondary" onclick="smMoveOverdueToToday()">今日に移す</button>`;
    }

    window.smMoveOverdueToToday = function () {
        const today = getTodayString();
        state.tasks.forEach(t => {
            if (!t.completed && !t.isRoutine && t.date && t.date < today) t.date = today;
        });
        saveData();
    };

    // ── renderDashboard をラップ ───────────────────────────
    const _origRender = renderDashboard;
    renderDashboard = function () {
        _origRender.apply(this, arguments);
        if (isSimple()) decorateTaskRows();
        renderNowBar();
        renderCarryBar();
    };

    // タイマー画面で操作したときも計測中バーを更新
    const _origSyncTimerUI = syncTimerUI;
    syncTimerUI = function () {
        _origSyncTimerUI.apply(this, arguments);
        renderNowBar();
    };

    // ── 設定画面のトグル ───────────────────────────────────
    function setupSettingsToggle() {
        const header = document.querySelector('#view-settings .view-header');
        if (!header) return;
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.style.marginBottom = '1.5rem';
        panel.innerHTML = `
            <label class="sm-settings-row" for="sm-toggle">
                <div>
                    <h3 style="margin:0 0 4px;">シンプルモード</h3>
                    <p class="help-text" style="margin:0;">今日のタスクとタイマーだけを表示します。オフにすると全機能が戻ります（データはどちらでも保持されます）。</p>
                </div>
                <input type="checkbox" id="sm-toggle">
            </label>`;
        header.insertAdjacentElement('afterend', panel);
        const cb = panel.querySelector('#sm-toggle');
        cb.checked = isSimple();
        cb.addEventListener('change', () => {
            state.settings.simpleMode = cb.checked;
            saveData();
            applySimpleMode();
        });
    }

    let lastMode = null;

    // ── 適用 ───────────────────────────────────────────────
    function applySimpleMode() {
        const on = isSimple();
        lastMode = on;
        document.body.classList.toggle('simple-mode', on);
        if (nameInput) {
            nameInput.placeholder = on ? '例: レポート 60分 明日 #勉強' : originalPlaceholder;
        }
        const cb = document.getElementById('sm-toggle');
        if (cb) cb.checked = on;
        renderDashboard();
    }

    // クラウド同期で state が置き換わったときにも追従する
    setInterval(() => {
        const mode = isSimple();
        if (mode !== lastMode) { lastMode = mode; applySimpleMode(); }
    }, 2000);

    markAdvanced();
    setupForm();
    setupBars();
    setupSettingsToggle();
    lastMode = isSimple();
    applySimpleMode();
})();
