/**
 * Daily Flow - Browser Task Manager
 * All data is stored locally in localStorage. No external API is used.
 */

const STORAGE_KEY = 'daily_flow_data';

// --- State Management ---
let state = {
    tasks: [],        // { id, text, duration, load, completed, isRoutine, tag, date }
    routines: [],     // { id, text, duration, tag }
    schedules: [],    // { id, gcalId, title, date, startTime, endTime, tag, memo }
    history: {},      // { 'YYYY-MM-DD': { rate, tasksTotal, tasksCompleted, memo, durationByTag } }
    memos: [],        // { id, text, createdAt, done }
    lastDate: '',     // 'YYYY-MM-DD'
    dailyLoad: {      // daily load limit config
        limit: 4,     // default 4
        locked: false,// true once limit is changed that day
        date: ''      // 'YYYY-MM-DD' — the day this lock applies to
    },
    settings: {
        apiKey: 'AIzaSyDy-UDkVaLk5zLkojM3IOtzPZTwFpCtfSA',
        clientId: '402677092902-bceev6me91ekc1so00g2h96doqd1ripr.apps.googleusercontent.com',
        firebaseConfig: null,
        layoutMode: 'auto',
        googleEmail: null
    },
    timer: {
        taskId: null,
        startTime: null, // timestamp
        isRunning: false,
        accumulatedSeconds: 0
    },
    diary: {}    // { 'YYYY-MM-DD': { localNote } }
};

function getTodayString() {
    const now = new Date();
    // Treat midnight–5am as still belonging to the previous day (schedule boundary)
    if (now.getHours() < 5) {
        const prevDay = new Date(now);
        prevDay.setDate(prevDay.getDate() - 1);
        return prevDay.toLocaleDateString('en-CA');
    }
    return now.toLocaleDateString('en-CA');
}
function getTomorrowString() {
    const todayStr = getTodayString();
    // todayStr is YYYY-MM-DD; parse safely as local date
    const [y, m, d] = todayStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + 1);
    return dt.toLocaleDateString('en-CA');
}

function loadData() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        state = JSON.parse(saved);
        if (!state.schedules) state.schedules = [];
        if (!state.tasks) state.tasks = [];
        if (!state.routines) state.routines = [];
        if (!state.history) state.history = {};
        if (!state.settings) {
            state.settings = {
                apiKey: 'AIzaSyDy-UDkVaLk5zLkojM3IOtzPZTwFpCtfSA',
                clientId: '402677092902-bceev6me91ekc1so00g2h96doqd1ripr.apps.googleusercontent.com',
                firebaseConfig: null,
                layoutMode: 'auto'
            };
        }
        if (!state.settings.layoutMode) state.settings.layoutMode = 'auto';
        if (!state.settings.googleEmail) state.settings.googleEmail = null;
        state.tasks.forEach(t => {
            if (!t.date) t.date = getTodayString();
        });
        if (!state.memos) state.memos = [];
        if (!state.dailyLoad) state.dailyLoad = { limit: 4, locked: false, date: '' };
        if (state.dailyLoad.limit == null) state.dailyLoad.limit = 4;
        if (!state.timer) {
            state.timer = { taskId: null, startTime: null, isRunning: false, accumulatedSeconds: 0 };
        }
        if (!state.pausedTimers) state.pausedTimers = [];
        if (!state.calories) state.calories = {};
        if (!state.expenses) state.expenses = {};
        if (!state.diary) state.diary = {};
    }
    
    // Check for new day
    const today = getTodayString();
    if (state.lastDate !== today) {
        // Reset daily load lock for the new day
        if (!state.dailyLoad) state.dailyLoad = { limit: 4, locked: false, date: '' };
        state.dailyLoad.locked = false;
        state.dailyLoad.date = today;

        // Carry over incomplete non-routine tasks; routine tasks are regenerated fresh each day
        const carryOverTasks = state.tasks.filter(t => !t.completed && !t.isRoutine);
        const routineTasks = state.routines.map(r => ({
            id: generateId(),
            text: r.text,
            duration: r.duration,
            tag: r.tag || 'タスク',
            date: today,
            completed: false,
            isRoutine: true
        }));
        state.tasks = [...carryOverTasks, ...routineTasks];
        state.lastDate = today;
        saveData();
    }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (document.getElementById('view-dashboard').classList.contains('active')) {
        renderDashboard();
    }
    if (currentUser) {
        scheduleCloudSave();
    }
}

let _cloudSaveTimer = null;
function scheduleCloudSave() {
    if (_cloudSaveTimer) clearTimeout(_cloudSaveTimer);
    _cloudSaveTimer = setTimeout(() => {
        _cloudSaveTimer = null;
        saveToCloud();
    }, 2000);
}

function generateId() {
    return Math.random().toString(36).substring(2, 9);
}

// --- DOM Elements ---
// Views
const views = document.querySelectorAll('.view');
const navLinks = document.querySelectorAll('.nav-links li[data-view]');
// Dashboard
const formAdd = document.getElementById('add-task-form');
const inputName = document.getElementById('task-name');
const inputDuration = document.getElementById('task-duration');
const inputRoutine = document.getElementById('task-routine');
const inputTag = document.getElementById('task-tag');
const inputDate = document.getElementById('task-date');
const listActive = document.getElementById('active-task-list');
const listCompleted = document.getElementById('completed-task-list');
const countActive = document.getElementById('active-count');
const countCompleted = document.getElementById('completed-count');

// Progress
const dateDisplay = document.getElementById('current-date-display');
const progressRing = document.getElementById('daily-progress-ring');
const progressPercent = document.getElementById('daily-progress-percent');
const progressText = document.getElementById('progress-text');




// History Calendar
const calendarMonthYear = document.getElementById('calendar-month-year');
const calendarDays = document.getElementById('calendar-days');
const btnPrevMonth = document.getElementById('prev-month');
const btnNextMonth = document.getElementById('next-month');
const historyDetailContent = document.getElementById('history-detail-content');
let currentCalendarDate = new Date();

// Stats View
const btnStatDaily = document.getElementById('btn-stat-daily');
const btnStatWeekly = document.getElementById('btn-stat-weekly');
const btnStatMonthly = document.getElementById('btn-stat-monthly');
const statsContent = document.getElementById('stats-content');

// Schedule View
const btnPrevWeek = document.getElementById('prev-week');
const btnNextWeek = document.getElementById('next-week');
const formSchedule = document.getElementById('add-schedule-form');
let currentWeekStart = new Date(); // Represents the currently selected date in schedule view

// Timer Elements
const btnTimerStart = document.getElementById('btn-timer-start');
const btnTimerPause = document.getElementById('btn-timer-pause');
const btnTimerFinish = document.getElementById('btn-timer-finish');
const btnTimerReset = document.getElementById('btn-timer-reset');
const btnTimerCancel = document.getElementById('btn-timer-cancel');
const timerDisplay = document.getElementById('timer-display');
const timerSelect = document.getElementById('timer-task-select');

function getMonday(d) {
  d = new Date(d);
  var day = d.getDay(),
      diff = d.getDate() - day + (day == 0 ? -6:1);
  return new Date(d.setDate(diff));
}

// --- Google API ---
let isSilentAuthAttempt = false;
const DISCOVERY_DOCS = [
    'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
    'https://www.googleapis.com/discovery/v1/apis/docs/v1/rest',
];
// Calendar / Gmail scopes — kept separate from Drive so silent auth never fails
// due to a new drive.file consent requirement.
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/documents';
const DIARY_DOC_ID = '1dUD73pq2Gx3al3OlQPZFgsLOmGf5ulUvuQHkLRJXi_g';

let tokenClient;       // calendar + gmail
let driveTokenClient;  // documents scope — used for diary transcription
let driveAuthCallback = null;

let gapiInited = false;
let gisInited = false;
let authCallback = null;

function initGAPI() {
    if (window.gapi && state.settings && state.settings.apiKey) {
        gapi.load('client', async () => {
            try {
                await gapi.client.init({
                    apiKey: state.settings.apiKey,
                    discoveryDocs: DISCOVERY_DOCS,
                });
                gapiInited = true;
            } catch(e) {
                console.error("GAPI init error", e);
                // gapi.client.init() throws when called a second time on an already-initialized
                // client. If calendar is already loaded, just update the API key and proceed.
                if (window.gapi && gapi.client && gapi.client.calendar) {
                    gapi.client.setApiKey(state.settings.apiKey);
                    gapiInited = true;
                } else {
                    // Discovery docs not loaded yet — try loading calendar directly
                    try {
                        gapi.client.setApiKey(state.settings.apiKey);
                        await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest');
                        gapiInited = true;
                    } catch(e2) {
                        console.error("GAPI fallback init error", e2);
                    }
                }
            }
        });
    } else if (!window.gapi && state.settings && state.settings.apiKey) {
        // gapi.js not yet loaded — retry once after a short delay
        setTimeout(initGAPI, 2000);
        return;
    }
    if (window.google && state.settings && state.settings.clientId) {
        // Main token client: calendar + gmail (used for all existing sync flows)
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: state.settings.clientId,
            scope: SCOPES,
            callback: (resp) => {
                if (resp.error !== undefined) {
                    if (!isSilentAuthAttempt) {
                        alert("認証エラー: " + resp.error);
                    } else {
                        console.log("[Auto-sync] silent auth result:", resp.error);
                    }
                    return;
                }
                if (authCallback) authCallback();
            },
        });
        // Docs token client: documents scope — used for diary transcription to fixed Google Doc
        driveTokenClient = google.accounts.oauth2.initTokenClient({
            client_id: state.settings.clientId,
            scope: DRIVE_SCOPE,
            callback: (resp) => {
                if (resp.error !== undefined) {
                    console.error('[Drive auth]', resp.error);
                    if (resp.error === 'interaction_required' || resp.error === 'access_denied') {
                        // Silent auth failed — show explicit consent/account-picker screen
                        driveTokenClient.requestAccessToken({ prompt: 'consent' });
                        return;
                    }
                    driveAuthCallback = null;
                    const btn = document.getElementById('btn-transcribe-diary');
                    if (btn) { btn.disabled = false; btn.textContent = '転記する'; }
                    return;
                }
                // GIS sets the token on gapi.client automatically, but only if
                // gapi.client is loaded. Explicit setToken() as a safety net.
                if (window.gapi && gapi.client) {
                    gapi.client.setToken(resp);
                }
                if (driveAuthCallback) {
                    const fn = driveAuthCallback;
                    driveAuthCallback = null;
                    fn();
                }
            },
        });
        gisInited = true;
    }
}

// --- Timer Logic ---
let timerInterval = null;

function formatTimer(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

const TRIVIA = [
    "空が青いのは、太陽の光が大気中の分子に当たって散乱し、波長の短い青い光が特に強く散乱されるからです（レイリー散乱）。",
    "キリンの舌はとても長く、45cmから50cmほどもあり、自分の耳を掃除することもできます。",
    "バナナは草の仲間で、木ではありません。また、イチゴはバラ科に属しています。",
    "金星の1日は、地球の1年よりも長いです。金星が自転する速さは非常にゆっくりです。",
    "人間の体の中で一番硬い組織は、歯のエナメル質です。",
    "タコには心臓が3つあり、脳も9つ（各腕に1つずつと中央に1つ）あります。",
    "世界で一番短い戦争は、イギリスとザンジバルの間で起きたもので、わずか38分で終わりました。",
    "宇宙には匂いがあると言われており、宇宙飛行士によると「焼けたステーキ」や「熱い金属」のような匂いがするそうです。",
    "クジラの心臓は非常に大きく、人間がその血管の中を泳げるほどのサイズのものもあります。",
    "ペンギンは膝を曲げて座っています。足が短いように見えますが、実は体の中に長い脚が隠れています。",
    "ミツバチは、1kgの蜂蜜を作るために、地球を約3周する距離を飛び回る必要があります。",
    "カメレオンの舌の長さは、自分の体の約2倍にもなります。",
    "アボカドは果物の一種ですが、脂肪分が多いため「森のバター」と呼ばれます。",
    "エッフェル塔は、夏になると熱膨張によって高さが約15cm高くなることがあります。",
    "マヨネーズはもともと、スペインのメノルカ島にあるマオンという町で作られたソース（マオンのソース）が語源です。",
    "地球の自転速度は徐々に遅くなっており、100年ごとに1日の長さが約2ミリ秒長くなっています。",
    "ナマケモノは泳ぐのが意外と得意で、地上よりも水中のほうが速く移動できます。",
    "シャチはイルカの仲間の中で最大の種です。",
    "富士山の山頂は、実は特定の県（静岡県や山梨県）に属しておらず、富士山本宮浅間大社の私有地です。",
    "トランプのカードの4人のキングは、それぞれ歴史上の有名な人物（アレキサンダー大王、カエサル、ダビデ王、シャルルマーニュ）がモデルと言われています。"
];

const PRAISES = [
    "お疲れ様でした！素晴らしい集中力です。",
    "完遂おめでとうございます！一歩前進ですね。",
    "ナイスワーク！この調子で頑張りましょう。",
    "やりきりましたね！自分を褒めてあげてください。",
    "集中お疲れ様でした。少し休憩も挟んでくださいね。"
];

function showTimerCompletionModal(taskName) {
    const modal = document.getElementById('timer-completion-modal');
    const title = document.getElementById('timer-praise-title');
    const taskEl = document.getElementById('completed-task-name');
    const trivia = document.getElementById('timer-trivia-content');
    
    if (modal) {
        title.textContent = PRAISES[Math.floor(Math.random() * PRAISES.length)];
        taskEl.textContent = taskName || "タスク完了";
        trivia.textContent = TRIVIA[Math.floor(Math.random() * TRIVIA.length)];
        modal.classList.add('active');
        
        createConfetti();
    }
}

function createConfetti() {
    const wrapper = document.getElementById('confetti-wrapper');
    if (!wrapper) return;
    wrapper.innerHTML = '';
    const colors = ['#f8fafc', '#6366f1', '#10b981', '#f59e0b', '#ef4444'];
    
    for (let i = 0; i < 40; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = Math.random() * 100 + '%';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = Math.random() * 0.5 + 's';
        piece.style.animationDuration = (Math.random() * 1.2 + 0.8) + 's';
        wrapper.appendChild(piece);
    }
}

function updateTimerSelect() {
    if (!timerSelect) return;
    
    // Restore selection: current value OR state-stored taskId
    const valToRestore = timerSelect.value || (state.timer ? state.timer.taskId : "");
    
    timerSelect.innerHTML = '<option value="">(タスクを選択してください)</option>';
    
    // 1. Get today's incomplete tasks + past incomplete tasks
    const todayStr = getTodayString();
    let tasksToShow = state.tasks.filter(t => !t.completed && t.date <= todayStr);
    
    // 2. If a timer is active, ensure THAT task is in the list (even if from another day or completed)
    if (state.timer && state.timer.taskId) {
        const timedTask = state.tasks.find(t => t.id === state.timer.taskId);
        if (timedTask && !tasksToShow.find(t => t.id === timedTask.id)) {
            tasksToShow.push(timedTask);
        }
    }
    
    tasksToShow.sort((a, b) => a.text.localeCompare(b.text));

    tasksToShow.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        const dateNote = t.date !== todayStr ? ` (${t.date.substring(5)})` : "";
        opt.textContent = t.text + dateNote;
        timerSelect.appendChild(opt);
    });
    
    if (valToRestore) {
        timerSelect.value = valToRestore;
    }
}

function updateTimerDisplay() {
    if (!state.timer || !timerDisplay) return;
    
    let totalSeconds = state.timer.accumulatedSeconds;
    if (state.timer.isRunning && state.timer.startTime) {
        const elapsed = Math.floor((Date.now() - state.timer.startTime) / 1000);
        totalSeconds += elapsed;
    }
    
    timerDisplay.textContent = formatTimer(totalSeconds);
}

function runTimerInterval() {
    if (timerInterval) clearInterval(timerInterval);
    updateTimerDisplay();
    timerInterval = setInterval(updateTimerDisplay, 1000);
}

function syncTimerUI() {
    if (!state.timer) return;
    
    if (state.timer.isRunning) {
        timerSelect.value = state.timer.taskId;
        timerSelect.disabled = true;
        btnTimerStart.innerHTML = '⏸ 一時停止';
        btnTimerStart.classList.replace('primary', 'secondary');
        btnTimerPause.style.display = 'none';
        btnTimerFinish.disabled = false;
        btnTimerCancel.style.display = 'block';
        if (btnTimerReset) btnTimerReset.style.display = 'block';
        runTimerInterval();
    } else if (state.timer.accumulatedSeconds > 0) {
        timerSelect.value = state.timer.taskId;
        timerSelect.disabled = false;
        btnTimerStart.innerHTML = '▶ 再開';
        btnTimerStart.classList.replace('secondary', 'primary');
        btnTimerPause.style.display = 'none';
        btnTimerFinish.disabled = false;
        btnTimerCancel.style.display = 'block';
        if (btnTimerReset) btnTimerReset.style.display = 'block';
        updateTimerDisplay();
    } else {
        timerSelect.disabled = false;
        btnTimerStart.innerHTML = '▶ 開始';
        btnTimerStart.classList.replace('secondary', 'primary');
        btnTimerPause.style.display = 'none';
        btnTimerCancel.style.display = 'none';
        if (btnTimerReset) btnTimerReset.style.display = 'none';
        updateTimerDisplay();
    }
    renderPausedTimers();
}

function renderPausedTimers() {
    const container = document.getElementById('paused-timers-list');
    if (!container) return;
    if (!state.pausedTimers || state.pausedTimers.length === 0) {
        container.innerHTML = '';
        return;
    }
    const items = state.pausedTimers.map(pt => {
        const task = state.tasks.find(t => t.id === pt.taskId);
        const name = task ? task.text : '(削除済みタスク)';
        return `<div class="paused-timer-item" onclick="resumePausedTimer('${pt.taskId}')">
            <span class="paused-timer-name">⏸ ${name}</span>
            <span class="paused-timer-time">${formatTimer(pt.accumulatedSeconds)}</span>
        </div>`;
    }).join('');
    container.innerHTML = `<p class="paused-timers-label">一時停止中のタスク</p>${items}`;
}

function stashCurrentTimer() {
    if (!state.timer.taskId || state.timer.accumulatedSeconds <= 0) return;
    const idx = state.pausedTimers.findIndex(t => t.taskId === state.timer.taskId);
    if (idx >= 0) {
        state.pausedTimers[idx].accumulatedSeconds = state.timer.accumulatedSeconds;
    } else {
        state.pausedTimers.push({ taskId: state.timer.taskId, accumulatedSeconds: state.timer.accumulatedSeconds });
    }
}

function resumePausedTimer(taskId) {
    if (state.timer.isRunning) {
        const elapsed = Math.floor((Date.now() - state.timer.startTime) / 1000);
        state.timer.accumulatedSeconds += elapsed;
        state.timer.isRunning = false;
        state.timer.startTime = null;
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        stashCurrentTimer();
    } else if (state.timer.taskId && state.timer.taskId !== taskId && state.timer.accumulatedSeconds > 0) {
        stashCurrentTimer();
    }
    const idx = state.pausedTimers.findIndex(t => t.taskId === taskId);
    state.timer.accumulatedSeconds = idx >= 0 ? state.pausedTimers.splice(idx, 1)[0].accumulatedSeconds : 0;
    state.timer.taskId = taskId;
    state.timer.isRunning = true;
    state.timer.startTime = Date.now();
    updateTimerSelect();
    timerSelect.value = taskId;
    saveData();
    syncTimerUI();
}

// --- Firebase Sync ---
let db = null;
let auth = null;
let currentUser = null;
let _cloudFetchDone = false; // guard: fetch once per session, not on every auth token refresh

// True when local changes have not yet been pushed to Firestore
let hasPendingCloudSync = false;

function updateNetworkStatusUI() {
    const badge = document.getElementById('network-status');
    const label = document.getElementById('network-label');
    const banner = document.getElementById('offline-banner');

    if (navigator.onLine) {
        if (badge) badge.className = 'network-status-badge online';
        if (label) label.textContent = hasPendingCloudSync ? '同期待ち...' : 'オンライン';
        if (banner) banner.style.display = 'none';
    } else {
        if (badge) badge.className = 'network-status-badge offline';
        if (label) label.textContent = 'オフライン';
        if (banner) banner.style.display = 'flex';
    }
}

async function handleOnline() {
    updateNetworkStatusUI();
    // Push any locally-queued changes to Firestore when connection is restored
    if (hasPendingCloudSync && currentUser && db) {
        await saveToCloud();
    }
    updateNetworkStatusUI();
}

function initFirebase() {
    if (window.firebase && state.settings && state.settings.firebaseConfig) {
        try {
            if (!firebase.apps.length) {
                firebase.initializeApp(state.settings.firebaseConfig);
            }
            db = firebase.firestore();
            // Enable offline persistence so writes are queued locally when offline
            // and automatically synced when the connection is restored.
            db.enablePersistence({ synchronizeTabs: true }).catch(err => {
                // failed-precondition: multiple tabs open (only one tab gets persistence)
                // unimplemented: browser does not support IndexedDB
                if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
                    console.warn('Firestore persistence error:', err);
                }
            });
            auth = firebase.auth();
            
            // Listen to auth state
            auth.onAuthStateChanged(user => {
                const loggedOutDiv = document.getElementById('auth-logged-out');
                const loggedInDiv = document.getElementById('auth-logged-in');
                const avatar = document.getElementById('user-avatar');
                const name = document.getElementById('user-name');
                
                if (user) {
                    currentUser = user;
                    if(loggedOutDiv) loggedOutDiv.style.display = 'none';
                    if(loggedInDiv) loggedInDiv.style.display = 'flex';
                    if(avatar) avatar.src = user.photoURL || '';
                    if(name) name.textContent = user.displayName || 'ユーザー';

                    if (!_cloudFetchDone) {
                        _cloudFetchDone = true;
                        fetchCloudData();
                    }
                } else {
                    currentUser = null;
                    _cloudFetchDone = false; // allow fresh fetch on next login
                    if(loggedOutDiv) loggedOutDiv.style.display = 'block';
                    if(loggedInDiv) loggedInDiv.style.display = 'none';
                }
            });
        } catch (e) {
            console.error("Firebase init error", e);
        }
    }
}

async function fetchCloudData() {
    if (!db || !currentUser) return;
    try {
        const docRef = db.collection('users').doc(currentUser.uid);
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const cloudState = docSnap.data();
            const today = getTodayString();
            const cloudDate = cloudState.lastDate || '';

            // ── Non-task state: always take from cloud ──
            state.routines   = cloudState.routines   || [];
            state.schedules  = cloudState.schedules  || [];
            state.history    = cloudState.history    || {};
            state.pausedTimers = cloudState.pausedTimers || [];
            state.calories   = cloudState.calories   || {};
            state.expenses   = cloudState.expenses   || {};
            state.memos      = cloudState.memos      || [];
            state.diary      = cloudState.diary      || {};
            if (cloudState.settings) {
                state.settings = { ...state.settings, ...cloudState.settings };
            }
            if (cloudState.timer) {
                if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
                state.timer = cloudState.timer;
            }

            // ── Task reconciliation ──
            if (cloudDate < today) {
                // Cloud is from a previous day: apply new-day logic to cloud task list.
                const carryOver = (cloudState.tasks || []).filter(t => !t.completed && !t.isRoutine);
                const freshRoutines = state.routines.map(r => ({
                    id: generateId(), text: r.text, duration: r.duration,
                    tag: r.tag || 'タスク', date: today, completed: false, isRoutine: true
                }));
                state.tasks = [...carryOver, ...freshRoutines];
                state.lastDate = today;
            } else if (cloudDate === today) {
                // Cloud is current for today: merge to keep locally added tasks that
                // haven't reached the cloud yet (e.g. added within the 2-s debounce window).
                const cloudIds = new Set((cloudState.tasks || []).map(t => t.id));
                const localOnly = state.tasks.filter(t => !cloudIds.has(t.id));
                state.tasks = [...(cloudState.tasks || []), ...localOnly];
                state.lastDate = today;
            } else {
                // Cloud is ahead (multi-device edge case): trust cloud completely.
                state.tasks = cloudState.tasks || [];
                state.lastDate = cloudState.lastDate;
            }

            // Persist the reconciled state and push to cloud
            saveData();

            // Re-render
            renderDashboard();
            syncTimerUI();
            if (document.getElementById('view-history').classList.contains('active')) renderHistoryCalendar();
            if (document.getElementById('view-schedule').classList.contains('active')) renderWeeklySchedule();

            const syncStatus = document.getElementById('sync-status');
            if (syncStatus) {
                syncStatus.textContent = '同期済 ✓';
                syncStatus.style.color = 'var(--success-color)';
            }
        } else {
            // First login — upload local data to cloud
            saveToCloud();
        }
    } catch (e) {
        console.error("Error fetching cloud data", e);
    }
}

async function saveToCloud() {
    if (!db || !currentUser) return;
    try {
        const syncStatus = document.getElementById('sync-status');
        if (syncStatus) {
            syncStatus.textContent = '同期中...';
            syncStatus.style.color = 'var(--text-secondary)';
        }
        
        const dataToSave = {
            tasks: state.tasks,
            routines: state.routines,
            schedules: state.schedules,
            history: state.history,
            lastDate: state.lastDate,
            settings: state.settings,
            timer: state.timer,
            pausedTimers: state.pausedTimers,
            calories: state.calories,
            expenses: state.expenses,
            memos: state.memos,
            diary: state.diary
        };
        await db.collection('users').doc(currentUser.uid).set(dataToSave);

        hasPendingCloudSync = false;
        if (syncStatus) {
            syncStatus.textContent = '同期済 ✓';
            syncStatus.style.color = 'var(--success-color)';
        }
        updateNetworkStatusUI();
    } catch (e) {
        console.error("Error saving to cloud", e);
        hasPendingCloudSync = true;
        const syncStatus = document.getElementById('sync-status');
        if (syncStatus) {
            syncStatus.textContent = '同期失敗 ✕';
            syncStatus.style.color = 'var(--danger-color)';
        }
        updateNetworkStatusUI();
    }
}

// --- Weather Fetch ---
function isRainCode(c) {
    return (c >= 51 && c <= 65) || (c >= 80 && c <= 82) || c >= 95;
}

async function fetchWeather() {
    const weatherDisplay = document.getElementById('weather-display');
    if (!weatherDisplay) return;

    const lat = 35.6895;
    const lon = 139.6917;

    try {
        // Request current weather + hourly precipitation & weathercode for 2 days
        // (2 days ensures we always have 12 hours ahead even late at night)
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
            + `&current_weather=true`
            + `&hourly=precipitation,weathercode`
            + `&timezone=Asia%2FTokyo&forecast_days=2`;

        const response = await fetch(url);
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();

        const code = data.current_weather.weathercode;

        let icon = '🌤️';
        let desc = '不明';
        if (code === 0)                        { icon = '☀️';  desc = '快晴'; }
        else if (code <= 3)                    { icon = '⛅';  desc = '晴れ/曇り'; }
        else if (code === 45 || code === 48)   { icon = '🌫️'; desc = '霧'; }
        else if (code >= 51 && code <= 55)     { icon = '🌧️'; desc = '霧雨'; }
        else if (code >= 61 && code <= 65)     { icon = '☔';  desc = '雨'; }
        else if (code >= 71 && code <= 75)     { icon = '⛄';  desc = '雪'; }
        else if (code >= 80 && code <= 82)     { icon = '🌦️'; desc = 'にわか雨'; }
        else if (code >= 85 && code <= 86)     { icon = '🌨️'; desc = '雪'; }
        else if (code >= 95)                   { icon = '⛈️'; desc = '雷雨'; }

        // ── 12-hour rain forecast ──
        const times  = data.hourly.time;          // "YYYY-MM-DDTHH:00"
        const precip = data.hourly.precipitation; // mm
        const hCode  = data.hourly.weathercode;

        // Find the index for the current hour
        const now = new Date();
        const padZ = n => String(n).padStart(2, '0');
        const currentHourStr = `${now.getFullYear()}-${padZ(now.getMonth()+1)}-${padZ(now.getDate())}T${padZ(now.getHours())}:00`;
        const curIdx = times.indexOf(currentHourStr);

        let rainBadgeHtml = '';
        if (curIdx !== -1) {
            // Look at hours +1 … +12 (skip the current hour; weather icon already covers it)
            let rainOffset = -1;
            for (let i = 1; i <= 12; i++) {
                const idx = curIdx + i;
                if (idx >= times.length) break;
                if (precip[idx] > 0 || isRainCode(hCode[idx])) {
                    rainOffset = i;
                    break;
                }
            }

            if (rainOffset !== -1) {
                const label = rainOffset === 1 ? '約1時間後' : `約${rainOffset}時間後`;
                rainBadgeHtml = `<span class="rain-forecast-badge" title="${label}に雨の予報">☔ ${label}</span>`;
            }
        }

        weatherDisplay.innerHTML = `<span title="${desc} (${data.current_weather.temperature}℃)">${icon}</span>${rainBadgeHtml}`;
    } catch (e) {
        console.error("Weather fetch failed:", e);
        weatherDisplay.innerHTML = '☁️';
        weatherDisplay.title = '天気情報が取得できませんでした';
    }
}

// --- Initialization ---
function init() {
    loadData();
    applyLayoutMode();
    setupEventListeners();
    
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
        // Only proceed if width actually changed (prevents issues with mobile address bars)
        if (window.innerWidth === lastWidth) return;
        lastWidth = window.innerWidth;

        if (state.settings && state.settings.layoutMode === 'auto') {
            const changed = applyLayoutMode();
            if (changed && document.getElementById('view-schedule').classList.contains('active')) {
                renderWeeklySchedule();
            }
        }
    });

    // Set today's display date
    const today = new Date();
    dateDisplay.textContent = today.toLocaleDateString('ja-JP', { weekday: 'short', month: 'long', day: 'numeric' });
    
    renderDashboard();
    fetchWeather();
    syncTimerUI();

    // Network status listeners
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', updateNetworkStatusUI);
    updateNetworkStatusUI();

    // Delay slightly to ensure external scripts are loaded, then attempt auto-sync
    setTimeout(() => {
        initGAPI();
        initFirebase();
        // After GAPI has had time to initialize, attempt background sync
        setTimeout(autoSyncGoogleCalendar, 3000);
    }, 1000);
}

// --- Navigation ---
function switchView(viewId) {
    views.forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.add('active');
    
    navLinks.forEach(link => {
        if (link.dataset.view === viewId) link.classList.add('active');
        else link.classList.remove('active');
    });

    if (viewId === 'dashboard') {
        renderDashboard();
    } else if (viewId === 'history') {
        renderHistoryCalendar();
    } else if (viewId === 'stats') {
        renderStats('daily');
        setActiveStatBtn(btnStatDaily);
        renderTimerBarChart();
        renderCalorieSection();
        renderExpenseSection();
    } else if (viewId === 'schedule') {
        renderWeeklySchedule();
    } else if (viewId === 'settings') {
        // Auto-fill form
        const inputClientId = document.getElementById('setting-client-id');
        const inputApiKey = document.getElementById('setting-api-key');
        if (state.settings && inputClientId && inputApiKey) {
            inputClientId.value = state.settings.clientId || '';
            inputApiKey.value = state.settings.apiKey || '';
        }
        
        const layoutSelect = document.getElementById('setting-layout-mode');
        if (layoutSelect && state.settings) {
            layoutSelect.value = state.settings.layoutMode || 'auto';
        }
        renderAdditionalCalendarList();
    }
}

function renderAdditionalCalendarList() {
    const container = document.getElementById('additional-calendar-list');
    if (!container) return;
    const ids = (state.settings && state.settings.additionalCalendarIds) || [];
    if (ids.length === 0) {
        container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-secondary);">追加カレンダーはまだ登録されていません。</p>';
        return;
    }
    const calColors = ['#3b82f6','#10b981','#f59e0b','#ec4899','#8b5cf6','#ef4444','#06b6d4'];
    container.innerHTML = ids.map((id, i) => `
        <div style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0.75rem;margin-bottom:0.4rem;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.1);">
            <span style="width:10px;height:10px;border-radius:50%;background:${calColors[i % calColors.length]};flex-shrink:0;"></span>
            <span style="flex:1;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${id}</span>
            <button onclick="removeAdditionalCalendar(${i})" style="background:none;border:none;color:var(--danger-color);cursor:pointer;font-size:1.1rem;line-height:1;padding:0 4px;">×</button>
        </div>
    `).join('');
}

function removeAdditionalCalendar(index) {
    if (!state.settings.additionalCalendarIds) return;
    state.settings.additionalCalendarIds.splice(index, 1);
    saveData();
    renderAdditionalCalendarList();
}

// --- Event Listeners ---
function setupEventListeners() {
    // Navigation
    navLinks.forEach(link => {
        link.addEventListener('click', () => switchView(link.dataset.view));
    });

    // Adding Task
    // Set date picker default to today
    if (inputDate) inputDate.value = getTodayString();

    // Hide/show date picker based on routine selection
    if (inputRoutine && inputDate) {
        inputRoutine.addEventListener('change', () => {
            const v = inputRoutine.value;
            if (v === 'true') {
                // 毎日: 日付指定は無効
                inputDate.closest('.input-group').style.opacity = '0.4';
                inputDate.disabled = true;
            } else if (v === 'tomorrow') {
                // 明日: 日付を翌日に自動設定（編集可能）
                inputDate.value = getTomorrowString();
                inputDate.disabled = false;
                inputDate.closest('.input-group').style.opacity = '1';
            } else {
                // 今日だけ
                inputDate.value = getTodayString();
                inputDate.disabled = false;
                inputDate.closest('.input-group').style.opacity = '1';
            }
        });
    }

    formAdd.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = inputName.value.trim();
        const duration = parseInt(inputDuration.value) || 0;
        const routineVal = inputRoutine.value;
        const isRoutine = routineVal === 'true';
        const tag = inputTag.value;
        const inputLoad = document.getElementById('task-load');
        const load = parseInt(inputLoad ? inputLoad.value : 1) || 1;
        let targetDate;
        if (isRoutine) {
            targetDate = getTodayString();
        } else if (routineVal === 'tomorrow') {
            targetDate = (inputDate && inputDate.value) ? inputDate.value : getTomorrowString();
        } else {
            targetDate = (inputDate && inputDate.value) ? inputDate.value : getTodayString();
        }

        if (text) {
            const ok = addTask(text, duration, isRoutine, tag, targetDate, load);
            if (ok !== false) {
                inputName.value = '';
                inputDuration.value = '';
                inputRoutine.value = 'false';
                inputTag.value = 'タスク';
                if (inputLoad) inputLoad.value = '1';
                if (inputDate) {
                    inputDate.value = getTodayString();
                    inputDate.disabled = false;
                    inputDate.closest('.input-group').style.opacity = '1';
                }
            }
        }
    });


    // Adding Memo (タスク未満)
    const formMemo = document.getElementById('add-memo-form');
    if (formMemo) {
        formMemo.addEventListener('submit', e => {
            e.preventDefault();
            const input = document.getElementById('memo-text');
            if (!input.value.trim()) return;
            addMemo(input.value);
            input.value = '';
        });
    }

    // Calendar
    btnPrevMonth.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
        renderHistoryCalendar();
    });
    btnNextMonth.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
        renderHistoryCalendar();
    });

    // Stats
    if(btnStatDaily) btnStatDaily.addEventListener('click', () => { setActiveStatBtn(btnStatDaily); renderStats('daily'); });
    if(btnStatWeekly) btnStatWeekly.addEventListener('click', () => { setActiveStatBtn(btnStatWeekly); renderStats('weekly'); });
    if(btnStatMonthly) btnStatMonthly.addEventListener('click', () => { setActiveStatBtn(btnStatMonthly); renderStats('monthly'); });

    // Timer chart period buttons
    const btnChart7  = document.getElementById('btn-chart-7d');
    const btnChart30 = document.getElementById('btn-chart-30d');
    function setChartBtn(active) {
        [btnChart7, btnChart30].forEach(b => b && b.classList.remove('active'));
        if (active) active.classList.add('active');
    }
    if (btnChart7)  btnChart7.addEventListener('click',  () => { timerChartDays = 7;  setChartBtn(btnChart7);  renderTimerBarChart(); });
    if (btnChart30) btnChart30.addEventListener('click', () => { timerChartDays = 30; setChartBtn(btnChart30); renderTimerBarChart(); });

    // Calorie handlers
    const btnAddCalorie    = document.getElementById('btn-add-calorie');
    const calorieLabel     = document.getElementById('calorie-label-input');
    const calorieAmount    = document.getElementById('calorie-amount-input');
    const calorieTargetEl  = document.getElementById('calorie-target-input');
    if (btnAddCalorie) btnAddCalorie.addEventListener('click', addCalorieRecord);
    if (calorieAmount) calorieAmount.addEventListener('keydown', e => { if (e.key === 'Enter') addCalorieRecord(); });
    if (calorieLabel)  calorieLabel.addEventListener('keydown',  e => { if (e.key === 'Enter') calorieAmount && calorieAmount.focus(); });
    if (calorieTargetEl) calorieTargetEl.addEventListener('change', () => {
        const v = parseInt(calorieTargetEl.value);
        if (v > 0) { state.settings.calorieTarget = v; saveData(); renderCalorieSection(); }
    });

    // Expense handlers
    const btnAddExpense   = document.getElementById('btn-add-expense');
    const expenseLabelEl  = document.getElementById('expense-label-input');
    const expenseAmountEl = document.getElementById('expense-amount-input');
    const expenseBudgetEl = document.getElementById('expense-budget-input');
    if (btnAddExpense)   btnAddExpense.addEventListener('click', addExpenseRecord);
    if (expenseAmountEl) expenseAmountEl.addEventListener('keydown', e => { if (e.key === 'Enter') addExpenseRecord(); });
    if (expenseLabelEl)  expenseLabelEl.addEventListener('keydown',  e => { if (e.key === 'Enter') expenseAmountEl && expenseAmountEl.focus(); });
    if (expenseBudgetEl) expenseBudgetEl.addEventListener('change', () => {
        const v = parseInt(expenseBudgetEl.value);
        if (v > 0) { state.settings.expenseBudget = v; saveData(); renderExpenseSection(); }
    });

    // Schedule
    if(btnPrevWeek) btnPrevWeek.addEventListener('click', () => {
        const isMobile = document.body.classList.contains('mobile-layout');
        const step = isMobile ? 1 : 7;
        currentWeekStart.setDate(currentWeekStart.getDate() - step);
        renderWeeklySchedule();
    });
    if(btnNextWeek) btnNextWeek.addEventListener('click', () => {
        const isMobile = document.body.classList.contains('mobile-layout');
        const step = isMobile ? 1 : 7;
        currentWeekStart.setDate(currentWeekStart.getDate() + step);
        renderWeeklySchedule();
    });

    const formSchedule = document.getElementById('add-schedule-form');
    if (formSchedule) {
        const dateInput = document.getElementById('schedule-date');
        if (dateInput) dateInput.value = getTodayString();
        formSchedule.addEventListener('submit', (e) => {
            e.preventDefault();
            const date = document.getElementById('schedule-date').value;
            const startStr = document.getElementById('schedule-start').value;
            const endStr = document.getElementById('schedule-end').value;
            const title = document.getElementById('schedule-title').value.trim();
            const tag = document.getElementById('schedule-tag').value;
            const memo = document.getElementById('schedule-memo').value.trim();
            const isRecord = document.getElementById('schedule-is-record') ? document.getElementById('schedule-is-record').checked : false;
            
            const finalTag = isRecord ? 'record' : tag;
            
            if(title && date && startStr && endStr) {
                state.schedules.push({
                    id: generateId(),
                    title: title,
                    date: date,
                    startTime: startStr,
                    endTime: endStr,
                    tag: finalTag,
                    memo: memo
                });
                saveData();
                document.getElementById('schedule-title').value = '';
                document.getElementById('schedule-memo').value = '';
                renderWeeklySchedule();
            }
        });
    }

    const btnSyncGcal = document.getElementById('btn-sync-gcal');
    if (btnSyncGcal) {
        btnSyncGcal.addEventListener('click', async () => {
            if (!gapiInited || !gisInited) {
                // If gapi/google scripts are now available but initGAPI hasn't completed yet,
                // try to initialize on-demand before giving up.
                if ((window.gapi || window.google) && state.settings?.apiKey && state.settings?.clientId) {
                    initGAPI();
                    // Wait up to 5 seconds for initialization to complete
                    for (let i = 0; i < 10; i++) {
                        await new Promise(r => setTimeout(r, 500));
                        if (gapiInited && gisInited) break;
                    }
                }
                if (!gapiInited || !gisInited) {
                    alert("Google APIが初期化されていません。設定画面でキーが正しく入力されているか確認してください。");
                    return;
                }
            }
            authCallback = fetchGoogleCalendarEvents;
            
            // Use prompt: '' instead of 'consent' to skip the consent screen if already authorized.
            // This still shows the account picker if multiple accounts are present.
            isSilentAuthAttempt = false;
            tokenClient.requestAccessToken({ prompt: '' });
        });
    }

    // Settings
    const formSettings = document.getElementById('settings-form');
    if (formSettings) {
        formSettings.addEventListener('submit', (e) => {
            e.preventDefault();
            state.settings.clientId = document.getElementById('setting-client-id').value.trim();
            state.settings.apiKey = document.getElementById('setting-api-key').value.trim();
            saveData();
            initGAPI();
            
            const msg = document.getElementById('settings-save-msg');
            msg.style.opacity = '1';
            setTimeout(() => { msg.style.opacity = '0'; }, 3000);
        });
    }

    // Firebase Settings
    const fbForm = document.getElementById('firebase-settings-form');
    if (fbForm) {
        const inputFb = document.getElementById('setting-firebase-config');
        if (state.settings && state.settings.firebaseConfig) {
            inputFb.value = JSON.stringify(state.settings.firebaseConfig, null, 2);
        }
        fbForm.addEventListener('submit', (e) => {
            e.preventDefault();
            try {
                const configStr = inputFb.value.trim();
                const configObj = new Function("return " + configStr)(); // Handles unquoted keys
                
                state.settings.firebaseConfig = configObj;
                saveData();
                
                const msg = document.getElementById('firebase-save-msg');
                msg.style.opacity = '1';
                setTimeout(() => { msg.style.opacity = '0'; }, 3000);
                
                initFirebase();
            } catch (err) {
                alert("JSONの形式が正しくありません。中括弧 {} で囲まれた有効な設定にしてください。");
            }
        });
    }

    // Firebase Auth Buttons
    const btnLogin = document.getElementById('btn-firebase-login');
    const btnLogout = document.getElementById('btn-firebase-logout');
    if (btnLogin) {
        btnLogin.addEventListener('click', () => {
            if (!auth) {
                alert("Firebaseの設定が行われていません。設定画面からfirebaseConfigを入力してください。");
                return;
            }
            const provider = new firebase.auth.GoogleAuthProvider();
            auth.signInWithPopup(provider).catch(err => {
                alert("ログイン失敗: " + err.message);
            });
        });
    }
    if (btnLogout) {
        btnLogout.addEventListener('click', () => {
            if (auth) auth.signOut();
        });
    }

    // Additional Calendar IDs
    const btnAddCalId = document.getElementById('btn-add-calendar-id');
    if (btnAddCalId) {
        btnAddCalId.addEventListener('click', () => {
            const input = document.getElementById('new-calendar-id');
            const val = input ? input.value.trim() : '';
            if (!val) return;
            if (!state.settings.additionalCalendarIds) state.settings.additionalCalendarIds = [];
            if (!state.settings.additionalCalendarIds.includes(val)) {
                state.settings.additionalCalendarIds.push(val);
                saveData();
            }
            if (input) input.value = '';
            renderAdditionalCalendarList();
        });
        const calInput = document.getElementById('new-calendar-id');
        if (calInput) {
            calInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnAddCalId.click(); });
        }
    }

    // Layout Settings
    const layoutSelect = document.getElementById('setting-layout-mode');
    if (layoutSelect) {
        layoutSelect.addEventListener('change', (e) => {
            if (!state.settings) state.settings = {};
            state.settings.layoutMode = e.target.value;
            saveData();
            applyLayoutMode();
        });
    }

    // Timer Handlers
    if (timerSelect) {
        timerSelect.addEventListener('change', () => {
            const newTaskId = timerSelect.value;
            if (!newTaskId || newTaskId === state.timer.taskId || state.timer.isRunning) return;
            stashCurrentTimer();
            const idx = state.pausedTimers.findIndex(t => t.taskId === newTaskId);
            state.timer.accumulatedSeconds = idx >= 0 ? state.pausedTimers.splice(idx, 1)[0].accumulatedSeconds : 0;
            state.timer.taskId = newTaskId;
            state.timer.isRunning = false;
            saveData();
            updateTimerDisplay();
            renderPausedTimers();
            if (state.timer.accumulatedSeconds > 0) {
                btnTimerStart.innerHTML = '▶ 再開';
                btnTimerFinish.disabled = false;
                btnTimerCancel.style.display = 'block';
                if (btnTimerReset) btnTimerReset.style.display = 'block';
            } else {
                btnTimerStart.innerHTML = '▶ 開始';
                btnTimerFinish.disabled = true;
                btnTimerCancel.style.display = 'none';
                if (btnTimerReset) btnTimerReset.style.display = 'none';
            }
            btnTimerStart.classList.replace('secondary', 'primary');
        });
    }

    if (btnTimerStart) {
        btnTimerStart.addEventListener('click', () => {
            const taskId = timerSelect.value;
            if (!taskId) return alert("タスクを選択してください");

            if (state.timer.isRunning) {
                // Pause
                const elapsed = Math.floor((Date.now() - state.timer.startTime) / 1000);
                state.timer.accumulatedSeconds += elapsed;
                state.timer.isRunning = false;
                state.timer.startTime = null;
                if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
                saveData();
                syncTimerUI();
            } else {
                // Start/Resume — task switching via change handler, but handle fallback
                if (state.timer.taskId !== taskId) {
                    stashCurrentTimer();
                    const idx = state.pausedTimers.findIndex(t => t.taskId === taskId);
                    state.timer.accumulatedSeconds = idx >= 0 ? state.pausedTimers.splice(idx, 1)[0].accumulatedSeconds : 0;
                    state.timer.taskId = taskId;
                }
                state.timer.isRunning = true;
                state.timer.startTime = Date.now();
                saveData();
                syncTimerUI();
            }
        });
    }
    
    // We can keep btnTimerPause for backward compatibility or just ignore it
    if (btnTimerPause) {
        btnTimerPause.style.display = 'none';
    }
    
    if (btnTimerFinish) {
        btnTimerFinish.addEventListener('click', () => {
            const now = Date.now();
            let totalSeconds = state.timer.accumulatedSeconds;
            if (state.timer.isRunning && state.timer.startTime) {
                totalSeconds += Math.floor((now - state.timer.startTime) / 1000);
            }

            if (timerInterval) clearInterval(timerInterval);
            timerInterval = null;

            if (totalSeconds < 60) {
                alert("1分未満のため、実績として記録されません。タイマーはそのまま継続できます。");
                if (state.timer.isRunning) runTimerInterval();
                return;
            }

            // Flash the timer display green before resetting
            timerDisplay.classList.add('timer-flash');

            const task = state.tasks.find(t => t.id === state.timer.taskId);
            if (task) {
                task.completed = true;

                const startTs = state.timer.isRunning ? state.timer.startTime : (now - totalSeconds * 1000);
                const startD = new Date(startTs);
                const endD = new Date(now);

                const startStr = `${startD.getHours().toString().padStart(2, '0')}:${startD.getMinutes().toString().padStart(2, '0')}`;
                const endStr = `${endD.getHours().toString().padStart(2, '0')}:${endD.getMinutes().toString().padStart(2, '0')}`;

                const dateStr = getTodayString();

                state.schedules.push({
                    id: generateId(),
                    title: `⏱ ${task.text}`,
                    date: dateStr,
                    startTime: startStr,
                    endTime: endStr,
                    tag: 'record',
                    taskTag: task.tag || 'タスク',
                    memo: `計測時間: ${formatTimer(totalSeconds)}`
                });

                const historyDateStr = getTodayString();
                if (!state.history[historyDateStr]) state.history[historyDateStr] = { rate: 0, tasksCompleted: 0, tasksTotal: 0, memo: '', durationByTag: {} };
                state.history[historyDateStr].tasksCompleted++;
            } else {
                console.error("[Timer] Task not found for ID:", state.timer.taskId);
            }

            const finishedTaskId = state.timer.taskId;
            state.timer = { taskId: null, startTime: null, isRunning: false, accumulatedSeconds: 0 };

            saveData();
            syncTimerUI();
            renderPausedTimers();

            if (document.getElementById('view-schedule').classList.contains('active')) {
                renderWeeklySchedule();
            }

            // Show modal immediately — flash animation (0.65s CSS) plays through the overlay fade-in
            const finishedTask = state.tasks.find(t => t.id === finishedTaskId);
            showTimerCompletionModal(finishedTask ? finishedTask.text : "");
            setTimeout(() => timerDisplay.classList.remove('timer-flash'), 700);
        });
    }

    if (btnTimerCancel) {
        btnTimerCancel.addEventListener('click', () => {
            if (!confirm("タイマーを中止しますか？（記録は残りません）")) return;
            
            if (timerInterval) clearInterval(timerInterval);
            timerInterval = null;
            
            state.timer = { taskId: null, startTime: null, isRunning: false, accumulatedSeconds: 0 };

            timerDisplay.textContent = '00:00:00';
            timerSelect.disabled = false;
            timerSelect.value = '';
            btnTimerPause.style.display = 'none';
            btnTimerStart.style.display = 'block';
            btnTimerStart.textContent = '▶ 開始';
            btnTimerFinish.disabled = true;
            btnTimerCancel.style.display = 'none';

            saveData();
            renderPausedTimers();
        });
    }

    if (btnTimerReset) {
        btnTimerReset.addEventListener('click', () => {
            if (timerInterval) clearInterval(timerInterval);
            timerInterval = null;

            const currentTaskId = state.timer.taskId;
            state.timer = { taskId: currentTaskId, startTime: null, isRunning: false, accumulatedSeconds: 0 };

            saveData();
            timerSelect.disabled = false;
            btnTimerFinish.disabled = true;
            btnTimerCancel.style.display = 'none';
            btnTimerReset.style.display = 'none';
            btnTimerStart.innerHTML = '▶ 開始';
            btnTimerStart.classList.replace('secondary', 'primary');
            timerDisplay.textContent = '00:00:00';
            updateTimerSelect();
            if (currentTaskId) timerSelect.value = currentTaskId;
            renderPausedTimers();
        });
    }

    const btnCloseTimerModal = document.getElementById('btn-close-timer-modal');
    if (btnCloseTimerModal) {
        btnCloseTimerModal.addEventListener('click', () => {
            document.getElementById('timer-completion-modal').classList.remove('active');
        });
    }

    const btnNextTask = document.getElementById('btn-next-task');
    if (btnNextTask) {
        btnNextTask.addEventListener('click', () => {
            document.getElementById('timer-completion-modal').classList.remove('active');

            const todayStr = getTodayString();
            const next = state.tasks
                .filter(t => !t.completed && t.date <= todayStr)
                .sort((a, b) => a.text.localeCompare(b.text))[0];

            updateTimerSelect();
            if (next) {
                timerSelect.value = next.id;
            }
        });
    }

}

function applyLayoutMode() {
    const mode = state.settings ? (state.settings.layoutMode || 'auto') : 'auto';
    const body = document.body;
    
    let target = '';
    if (mode === 'mobile') target = 'mobile-layout';
    else if (mode === 'pc') target = 'pc-layout';
    else {
        target = window.innerWidth <= 768 ? 'mobile-layout' : 'pc-layout';
    }
    
    if (!body.classList.contains(target)) {
        body.classList.remove('pc-layout', 'mobile-layout');
        body.classList.add(target);
        return true; // Changed
    }
    return false; // No change
}

function setActiveStatBtn(btn) {
    [btnStatDaily, btnStatWeekly, btnStatMonthly].forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

// --- Core Logic ---
function getTodayLoad() {
    const todayStr = getTodayString();
    return state.tasks
        .filter(t => t.date === todayStr && !t.isRoutine)
        .reduce((sum, t) => sum + (t.load || 0), 0);
}

function addTask(text, duration, isRoutine, tag = 'タスク', targetDate = getTodayString(), load = 1) {
    const todayStr = getTodayString();
    // Load limit check — only for today's non-routine tasks
    if (!isRoutine && targetDate === todayStr) {
        if (!state.dailyLoad) state.dailyLoad = { limit: 4, locked: false, date: todayStr };
        const usedLoad = getTodayLoad();
        const limit = state.dailyLoad.limit || 4;
        if (usedLoad + load > limit) {
            alert(`本日の負荷上限（${limit}）を超えるため登録できません。\n現在の使用済み負荷: ${usedLoad} / ${limit}`);
            return false;
        }
    }
    const task = {
        id: generateId(),
        text,
        duration,
        load: isRoutine ? 0 : (load || 1),
        tag,
        date: targetDate,
        completed: false,
        isRoutine
    };
    state.tasks.push(task);

    if (isRoutine) {
        // Add to routines list if not already there (by exact name)
        const exists = state.routines.find(r => r.text === text);
        if (!exists) {
            state.routines.push({ id: generateId(), text, duration, tag });
        }
    }
    saveData();
    return true;
}

function toggleTask(id) {
    const task = state.tasks.find(t => t.id === id);
    if (task) {
        task.completed = !task.completed;
        saveData();
    }
}

function deleteTask(id) {
    state.tasks = state.tasks.filter(t => t.id !== id);
    // Note: We don't delete from routines automatically to prevent accidental loss of routine template
    saveData();
}

function addSchedule(title, date, startTime, endTime, tag, memo, gcalId = null) {
    state.schedules.push({
        id: generateId(),
        gcalId,
        title,
        date,
        startTime,
        endTime,
        tag,
        memo
    });
    // saveData will be called by the caller
}

async function fetchGoogleCalendarEvents(silent = false) {
    try {
        // Always sync the whole week containing the selected date
        const start = getMonday(currentWeekStart);
        start.setHours(0,0,0,0);
        const end = new Date(currentWeekStart);
        end.setDate(end.getDate() + 7);
        end.setHours(0,0,0,0);

        // Build list of calendar IDs: primary + additional calendars from settings
        const additionalIds = (state.settings && state.settings.additionalCalendarIds) || [];
        const calendarIds = ['primary', ...additionalIds];

        // Tag names for each calendar slot (primary uses default 'カレンダー')
        const calTagNames = ['カレンダー', 'カレンダー2', 'カレンダー3', 'カレンダー4', 'カレンダー5', 'カレンダー6'];

        let added = 0;
        let updated = 0;
        let taskAdded = 0;
        let taskUpdated = 0;
        let totalEvents = 0;

        for (let ci = 0; ci < calendarIds.length; ci++) {
            const calId = calendarIds[ci];
            let response;
            try {
                response = await gapi.client.calendar.events.list({
                    'calendarId': calId,
                    'timeMin': start.toISOString(),
                    'timeMax': end.toISOString(),
                    'showDeleted': false,
                    'singleEvents': true,
                    'orderBy': 'startTime',
                    'timeZone': 'Asia/Tokyo'
                });
            } catch (calErr) {
                console.warn('[GCal] Failed to fetch calendar', calId, ':', calErr.message || calErr);
                continue;
            }

            // Save primary calendar email as login hint
            if (ci === 0 && response.result.summary && response.result.summary.includes('@')) {
                if (state.settings.googleEmail !== response.result.summary) {
                    state.settings.googleEmail = response.result.summary;
                }
            }

            const events = response.result.items || [];
            totalEvents += events.length;

            // Tag for this calendar slot
            const calTag = calTagNames[Math.min(ci, calTagNames.length - 1)];

            events.forEach(event => {
                if (!event.start.dateTime) return; // skip all-day events

                const rawStart = event.start.dateTime;
                const rawEnd   = event.end.dateTime;

                const dateStr  = rawStart.substring(0, 10);
                const startStr = rawStart.substring(11, 16);
                const endStr   = rawEnd.substring(11, 16);

                console.log('[GCal Debug] cal:', calId, 'raw:', rawStart, '\u2192', dateStr, startStr, '-', endStr);

                const gcalId = event.id;
                const title = event.summary || '予定';
                const memo = event.description || '';

                // --- Schedule registration ---
                const existingIdx = state.schedules.findIndex(s => s.gcalId === gcalId);
                if (existingIdx !== -1) {
                    state.schedules[existingIdx].title = title;
                    state.schedules[existingIdx].date = dateStr;
                    state.schedules[existingIdx].startTime = startStr;
                    state.schedules[existingIdx].endTime = endStr;
                    state.schedules[existingIdx].memo = memo;
                    updated++;
                } else {
                    addSchedule(title, dateStr, startStr, endStr, calTag, memo, gcalId);
                    added++;
                }

                // --- Task registration for manaba events (enables timer use) ---
                if (title.toLowerCase().includes('manaba')) {
                    const [sh, sm] = startStr.split(':').map(Number);
                    const [eh, em] = endStr.split(':').map(Number);
                    const durationMin = (eh * 60 + em) - (sh * 60 + sm);

                    const existingTask = state.tasks.find(t => t.gcalId === gcalId);
                    if (existingTask) {
                        existingTask.text = title;
                        existingTask.date = dateStr;
                        existingTask.duration = durationMin;
                        taskUpdated++;
                    } else {
                        state.tasks.push({
                            id: generateId(),
                            gcalId,
                            text: title,
                            duration: durationMin,
                            tag: '勉強・課題',
                            date: dateStr,
                            completed: false,
                            isRoutine: false
                        });
                        taskAdded++;
                    }
                }
            });
        }

        saveData();
        if (document.getElementById('view-schedule').classList.contains('active')) {
            renderWeeklySchedule();
        }

        // Update last-sync time display
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
        const gcalSyncEl = document.getElementById('gcal-last-sync');
        if (gcalSyncEl) gcalSyncEl.textContent = `GCal 最終同期: ${timeStr} (${calendarIds.length}件)`;

        console.log(`[GCal] done. calendars=${calendarIds.length}, totalEvents=${totalEvents}, added=${added}, updated=${updated}, taskAdded=${taskAdded}`);
        if (!silent) {
            const calMsg = calendarIds.length > 1 ? `（${calendarIds.length}件のカレンダーを同期）\n` : '';
            const taskMsg = taskAdded > 0 ? `\nタスク自動登録(manaba): ${taskAdded}件` : '';
            if (totalEvents === 0) {
                alert(`${calMsg}今週の予定は見つかりませんでした。`);
            } else {
                alert(`${calMsg}Googleカレンダーと自動同期しました！\n（新規: ${added}件, 更新: ${updated}件）${taskMsg}`);
            }
        }
        
    } catch (err) {
        console.error(err);
        if (!silent) {
            alert('同期に失敗しました: ' + (err.message || '不明なエラー'));
        } else {
            console.log('[Auto-sync] failed silently:', err.message);
        }
    }
}

// --- Auto Sync ---
// Attempts a silent token refresh and syncs Google Calendar in the background.
// Works when the user has previously granted consent and the session is still alive.
function autoSyncGoogleCalendar() {
    if (!gapiInited || !gisInited) return;
    if (gapi.client.getToken() === null) return;
    fetchGoogleCalendarEvents(true);
}

// --- Memo (タスク未満) ---
function renderMemos() {
    const memoList = document.getElementById('memo-list');
    const memoCount = document.getElementById('memo-count');
    if (!memoList) return;

    memoList.innerHTML = '';
    const memos = state.memos || [];
    if (memoCount) memoCount.textContent = memos.length;

    if (memos.length === 0) {
        memoList.innerHTML = '<li style="color:var(--text-secondary);font-size:0.85rem;padding:0.5rem 0;text-align:center;">まだ登録がありません</li>';
        return;
    }

    const svgTrash = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

    memos.forEach(memo => {
        const li = document.createElement('li');
        li.className = `memo-item${memo.done ? ' done' : ''}`;
        li.innerHTML = `
            <div class="memo-dot" onclick="toggleMemo('${memo.id}')"></div>
            <span class="memo-text" onclick="toggleMemo('${memo.id}')">${memo.text}</span>
            <span style="font-size:0.72rem;color:var(--text-secondary);margin-right:4px;white-space:nowrap;flex-shrink:0;">${memo.createdAt ? memo.createdAt.substring(5).replace('-', '/') : ''}</span>
            <button class="btn-delete" onclick="deleteMemo('${memo.id}')">${svgTrash}</button>
        `;
        memoList.appendChild(li);
    });
}

function addMemo(text) {
    if (!state.memos) state.memos = [];
    state.memos.unshift({ id: generateId(), text: text.trim(), createdAt: getTodayString(), done: false });
    saveData();
}

function deleteMemo(id) {
    state.memos = (state.memos || []).filter(m => m.id !== id);
    saveData();
}

function toggleMemo(id) {
    const memo = (state.memos || []).find(m => m.id === id);
    if (memo) { memo.done = !memo.done; saveData(); }
}

// --- Smart Text Parser ---
function smartParse(rawText, importType = 'task') {
    // Looks for patterns like "10:00～11:00 Event Name" or "10:00 - 11:30 Meeting"
    const lines = rawText.split('\n');
    const timeRegex = /(\d{1,2}:\d{2})\s*(?:～|-|~|to)\s*(\d{1,2}:\d{2})\s*(.*)/i;
    let added = 0;

    lines.forEach(line => {
        const match = line.match(timeRegex);
        if (match) {
            const startStr = match[1];
            const endStr = match[2];
            let name = match[3].trim();
            
            if (!name) name = "Imported Event";

            // Calculate duration
            const [sh, sm] = startStr.split(':').map(Number);
            const [eh, em] = endStr.split(':').map(Number);
            
            let startMins = sh * 60 + sm;
            let endMins = eh * 60 + em;
            if (endMins < startMins) endMins += 24 * 60; // crossed midnight
            
            if (importType === 'schedule') {
                const pad = n => String(n).padStart(2, '0');
                state.schedules.push({
                    id: generateId(),
                    title: name,
                    date: getTodayString(),
                    startTime: `${pad(sh)}:${pad(sm)}`,
                    endTime: `${pad(eh)}:${pad(em)}`,
                    tag: 'カレンダー',
                    memo: ''
                });
            } else {
                const duration = endMins - startMins;
                addTask(name, duration, false, 'カレンダー', getTodayString());
            }
            added++;
        } else if (line.trim().length > 0 && !line.includes('http')) {
            // Fallback for lines without time, maybe it's just a task list
            // Avoid parsing pure URLs
            if (importType === 'schedule') {
                // Ignore schedule imports without time
            } else {
                addTask(line.trim(), 0, false, 'カレンダー', getTodayString());
                added++;
            }
        }
    });

    if (added === 0) {
        alert("テキストからタスクを解析できませんでした。");
    }
}

// --- Rendering Dashboard ---
function renderLoadLimitUI() {
    const todayStr = getTodayString();
    if (!state.dailyLoad) state.dailyLoad = { limit: 4, locked: false, date: todayStr };

    const usedLoad = getTodayLoad();
    const limit = state.dailyLoad.limit || 4;
    const locked = state.dailyLoad.locked;

    // Update indicator
    const indicator = document.getElementById('load-indicator');
    if (indicator) {
        const pct = Math.min(100, Math.round((usedLoad / limit) * 100));
        const color = usedLoad >= limit ? 'var(--danger-color)' : usedLoad >= limit * 0.75 ? '#f59e0b' : 'var(--primary-color)';
        indicator.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
                <span style="font-size:0.85rem; color:var(--text-secondary);">本日の負荷</span>
                <span style="font-size:0.85rem; font-weight:600; color:${color};">${usedLoad} / ${limit}</span>
            </div>
            <div style="height:6px; border-radius:3px; background:rgba(255,255,255,0.1); overflow:hidden;">
                <div style="height:100%; width:${pct}%; background:${color}; border-radius:3px; transition:width 0.3s;"></div>
            </div>`;
    }

    // Update limit setter
    const limitSetter = document.getElementById('load-limit-setter');
    if (limitSetter) {
        if (locked) {
            limitSetter.innerHTML = `<span style="font-size:0.82rem; color:var(--text-secondary);">上限: <strong>${limit}</strong>（本日変更不可）</span>`;
        } else {
            limitSetter.innerHTML = `
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <span style="font-size:0.82rem; color:var(--text-secondary);">１日の登録上限:</span>
                    <input id="input-load-limit" type="number" min="1" value="${limit}"
                        style="width:60px; padding:4px 8px; border-radius:var(--radius-md); background:rgba(0,0,0,0.2);
                               border:1px solid var(--panel-border); color:var(--text-primary); font-size:0.85rem; text-align:center;">
                    <button id="btn-set-load-limit" type="button" class="btn secondary"
                        style="padding:4px 10px; font-size:0.82rem;">設定</button>
                </div>`;
            // Re-attach event after innerHTML replacement
            const btn = document.getElementById('btn-set-load-limit');
            if (btn) {
                btn.addEventListener('click', () => {
                    const inp = document.getElementById('input-load-limit');
                    const newLimit = parseInt(inp ? inp.value : 4);
                    if (!newLimit || newLimit < 1) { alert('1以上の整数を入力してください。'); return; }
                    state.dailyLoad.limit = newLimit;
                    state.dailyLoad.locked = true;
                    state.dailyLoad.date = getTodayString();
                    saveData();
                    renderLoadLimitUI();
                });
            }
        }
    }
}

function renderDashboard() {
    updateTimerSelect();
    listActive.innerHTML = '';
    listCompleted.innerHTML = '';

    let active = 0;
    let completed = 0;

    const todayStr = getTodayString();
    state.tasks.forEach(task => {
        const isToday = task.date === todayStr;
        const isOverdue = task.date < todayStr && !task.completed;
        
        if (!isToday && !isOverdue) return;
        
        const displayName = (task.date < todayStr) ? `${task.text} (${task.date.substring(5)})` : task.text;
        const li = document.createElement('li');
        li.className = 'task-item';
        
        // Duration string
        const durStr = task.duration ? `<span>🕒 ${task.duration}分</span>` : '';
        const routineStr = task.isRoutine ? `<span class="tag-routine">毎日</span>` : '';
        const loadStr = (!task.isRoutine && task.load) ? `<span style="font-size:0.78rem; color:var(--text-secondary);">💪 負荷${task.load}</span>` : '';

        const tagClassMap = {
            '講義': 'tag-lecture',
            '勉強・課題': 'tag-study',
            '趣味・遊び': 'tag-hobby',
            '運動': 'tag-exercise',
            'タスク': 'tag-task',
            'カレンダー': 'tag-calendar'
        };
        const tagClass = tagClassMap[task.tag] || 'tag-task';
        const tagBadge = `<span class="tag-badge ${tagClass}">${task.tag || 'タスク'}</span>`;

        li.innerHTML = `
            <div class="task-checkbox ${task.completed ? 'checked' : ''}" onclick="toggleTask('${task.id}')"></div>
            <div class="task-content">
                <div class="task-name">${displayName}</div>
                <div class="task-meta">
                    ${tagBadge}
                    ${durStr}
                    ${loadStr}
                    ${routineStr}
                </div>
            </div>
            <button class="btn-delete" onclick="deleteTask('${task.id}')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        `;

        if (task.completed) {
            listCompleted.appendChild(li);
            completed++;
        } else {
            listActive.appendChild(li);
            active++;
        }
    });

    countActive.textContent = active;
    countCompleted.textContent = completed;

    updateProgressRing(completed, active + completed);
    renderMemos();
    renderLoadLimitUI();
}

function updateProgressRing(completed, total) {
    const radius = 26;
    const circumference = radius * 2 * Math.PI;
    
    progressRing.style.strokeDasharray = `${circumference} ${circumference}`;
    
    let percent = total === 0 ? 0 : Math.round((completed / total) * 100);
    const offset = circumference - (percent / 100) * circumference;
    
    progressRing.style.strokeDashoffset = offset;
    progressPercent.textContent = `${percent}%`;

    if (total === 0) {
        progressText.textContent = "タスクを追加して計画を立てましょう。";
    } else if (percent === 100) {
        progressText.textContent = "すべて完了しました！お疲れ様でした。";
        progressRing.style.stroke = "var(--success-color)";
    } else {
        progressText.textContent = "その調子！頑張りましょう。";
        progressRing.style.stroke = "var(--primary-color)";
    }
}

// --- History Calendar ---
function renderHistoryCalendar() {
    calendarDays.innerHTML = '';
    
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    
    calendarMonthYear.textContent = currentCalendarDate.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' });
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'day-cell empty';
        calendarDays.appendChild(empty);
    }
    
    // Day cells
    const todayStr = getTodayString();

    for (let i = 1; i <= daysInMonth; i++) {
        const cellDate = new Date(year, month, i);
        const dateStr = cellDate.toLocaleDateString('en-CA'); // YYYY-MM-DD format for lookup
        
        const cell = document.createElement('div');
        cell.className = 'day-cell';
        cell.textContent = i;
        
        if (state.history[dateStr]) {
            cell.classList.add('has-data');
        }

        if (dateStr === todayStr) {
            cell.style.border = '1px solid var(--primary-color)';
        }

        cell.addEventListener('click', () => {
            // Remove selection
            document.querySelectorAll('.day-cell').forEach(c => c.classList.remove('selected'));
            cell.classList.add('selected');
            showHistoryDetail(dateStr);
        });

        calendarDays.appendChild(cell);
    }
}

function showHistoryDetail(dateStr) {
    const data = state.history[dateStr];
    const dayTasks = state.tasks.filter(t => t.date === dateStr);
    const daySchedules = state.schedules
        .filter(s => s.date === dateStr)
        .sort((a, b) => {
            // Sort by start time, treating <05:00 as next-day (same as schedule view)
            const toMins = t => {
                const [h, m] = t.split(':').map(Number);
                return (h < 5 ? h + 24 : h) * 60 + m;
            };
            return toMins(a.startTime) - toMins(b.startTime);
        });

    if (!data && daySchedules.length === 0 && dayTasks.length === 0) {
        historyDetailContent.innerHTML = `<p class="empty-state">この日のデータはありません。</p>`;
        return;
    }

    const tagBorderMap = {
        '講義':     '#3b82f6',
        '勉強・課題': '#10b981',
        '趣味・遊び': '#f59e0b',
        '運動':     '#ec4899',
        'タスク':    '#8b5cf6',
        'カレンダー': '#ef4444',
        'record':   '#0ea5e9'
    };
    const tagBgMap = {
        '講義':     'rgba(59, 130, 246, 0.12)',
        '勉強・課題': 'rgba(16, 185, 129, 0.12)',
        '趣味・遊び': 'rgba(245, 158, 11, 0.12)',
        '運動':     'rgba(236, 72, 153, 0.12)',
        'タスク':    'rgba(139, 92, 246, 0.12)',
        'カレンダー': 'rgba(239, 68, 68, 0.12)',
        'record':   'rgba(14, 165, 233, 0.18)'
    };

    let html = `<h4 style="font-size: 1rem; color: var(--text-secondary); margin-bottom: 1rem;">${dateStr}</h4>`;

    // --- Reflection summary ---
    if (data) {
        let rateColor = 'var(--text-primary)';
        if (data.rate >= 80) rateColor = 'var(--success-color)';
        else if (data.rate <= 30) rateColor = 'var(--danger-color)';

        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
                <span style="color:var(--text-secondary); font-size:0.9rem;">${data.tasksCompleted} / ${data.tasksTotal} タスク完了</span>
                <span style="font-size:1.4rem; font-weight:bold; color:${rateColor}">${data.rate}%</span>
            </div>`;

        if (data.memo) {
            html += `<div class="history-memo" style="margin-bottom:1.25rem;">${data.memo.replace(/\n/g, '<br>')}</div>`;
        }
    }

    // --- Task list ---
    if (dayTasks.length > 0) {
        html += `<div style="font-weight:600; font-size:0.85rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.05em; margin-bottom:0.5rem; margin-top:${data ? '0.25rem' : '0'};">タスク</div>`;
        dayTasks.forEach(task => {
            const done = task.completed;
            const color = tagBorderMap[task.tag] || tagBorderMap['タスク'];
            html += `
                <div style="display:flex; align-items:center; gap:0.6rem; padding:0.35rem 0; border-bottom:1px solid var(--panel-border); font-size:0.9rem;">
                    <span style="width:8px; height:8px; border-radius:50%; background:${color}; flex-shrink:0;"></span>
                    <span style="${done ? 'text-decoration:line-through; color:var(--text-secondary);' : ''}">${task.text}</span>
                    ${task.duration ? `<span style="margin-left:auto; color:var(--text-secondary); font-size:0.8rem; white-space:nowrap;">${task.duration}分</span>` : ''}
                </div>`;
        });
        html += `<div style="margin-bottom:1.25rem;"></div>`;
    }

    // --- Schedule timeline ---
    if (daySchedules.length > 0) {
        html += `<div style="font-weight:600; font-size:0.85rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.05em; margin-bottom:0.6rem;">スケジュール</div>`;
        daySchedules.forEach(sched => {
            const border = tagBorderMap[sched.tag] || tagBorderMap['タスク'];
            const bg    = tagBgMap[sched.tag]    || tagBgMap['タスク'];
            html += `
                <div style="display:flex; gap:0.6rem; align-items:stretch; margin-bottom:0.45rem;">
                    <div style="width:3px; background:${border}; border-radius:2px; flex-shrink:0;"></div>
                    <div style="flex:1; background:${bg}; border-radius:6px; padding:0.45rem 0.7rem;">
                        <div style="font-size:0.9rem; font-weight:500;">${sched.title}</div>
                        <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:0.1rem;">${sched.startTime} – ${sched.endTime}</div>
                        ${sched.memo ? `<div style="font-size:0.78rem; color:var(--text-secondary); margin-top:0.15rem;">${sched.memo}</div>` : ''}
                    </div>
                </div>`;
        });
    }

    // --- Expense summary ---
    const dayExpenses = (state.expenses && state.expenses[dateStr]) || [];
    if (dayExpenses.length > 0) {
        const expTotal = dayExpenses.reduce((s, r) => s + r.amount, 0);
        html += `<div style="font-weight:600; font-size:0.85rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.05em; margin-bottom:0.5rem; margin-top:1.25rem;">支出</div>`;
        html += `<div style="font-size:1.2rem; font-weight:700; color:var(--text-primary); margin-bottom:0.5rem;">¥${expTotal.toLocaleString()}</div>`;
        dayExpenses.forEach(r => {
            html += `
                <div style="display:flex; justify-content:space-between; padding:0.3rem 0; border-bottom:1px solid var(--panel-border); font-size:0.88rem;">
                    <span style="color:var(--text-primary);">${r.label}</span>
                    <span style="color:var(--text-secondary);">¥${r.amount.toLocaleString()}</span>
                </div>`;
        });
    }

    historyDetailContent.innerHTML = html;
}

// --- Stats Logic ---
function renderStats(period) {
    if (!statsContent) return;

    const today = new Date();
    const dates = [];

    if (period === 'daily') {
        dates.push(getTodayString());
    } else if (period === 'weekly') {
        // Last 7 days including today
        for (let i = 0; i < 7; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            dates.push(d.toLocaleDateString('en-CA'));
        }
    } else if (period === 'monthly') {
        // This month
        const year = today.getFullYear();
        const month = today.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        for (let i = 1; i <= daysInMonth; i++) {
            const d = new Date(year, month, i);
            dates.push(d.toLocaleDateString('en-CA'));
        }
    }

    const tagCounts = {};
    let totalMins = 0;
    const dateSet = new Set(dates);
    let plannedTotal = 0;
    let recordedTotal = 0;

    // Single pass: build tag breakdown AND achievement totals at once
    state.schedules.forEach(s => {
        if (!s.startTime || !s.endTime) return;
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        let startMin = sh * 60 + sm;
        let endMin = eh * 60 + em;
        if (endMin < startMin) endMin += 24 * 60;
        const mins = endMin - startMin;
        if (mins <= 0) return;

        if (s.tag === 'record') {
            recordedTotal += mins / 60;
            if (dateSet.has(s.date)) {
                let tag = s.taskTag;
                if (!tag) {
                    const taskName = s.title.replace(/^⏱\s*/, '');
                    const matched = state.tasks.find(t => t.text === taskName);
                    tag = (matched && matched.tag) ? matched.tag : 'タスク';
                }
                tagCounts[tag] = (tagCounts[tag] || 0) + mins;
                totalMins += mins;
            }
        } else if (s.tag !== 'カレンダー' && s.tag !== 'calendar') {
            plannedTotal += mins / 60;
        }
    });
    
    let achievePct = 0;
    if (plannedTotal > 0) {
        achievePct = Math.min(100, Math.round((recordedTotal / plannedTotal) * 100));
    }
    
    const ring = document.getElementById('stats-achievement-ring');
    const percentText = document.getElementById('stats-achievement-percent');
    const elPlanned = document.getElementById('stats-planned-hours');
    const elRecorded = document.getElementById('stats-recorded-hours');
    
    if (ring && percentText) {
        const circumference = 54 * 2 * Math.PI;
        const offset = circumference - (achievePct / 100) * circumference;
        ring.style.strokeDashoffset = offset;
        percentText.textContent = achievePct + '%';
        elPlanned.textContent = plannedTotal.toFixed(1) + ' 時間';
        elRecorded.textContent = recordedTotal.toFixed(1) + ' 時間';
    }

    const sortedTags = Object.keys(tagCounts).filter(t => tagCounts[t] > 0).sort((a, b) => tagCounts[b] - tagCounts[a]);

    if (sortedTags.length === 0) {
        statsContent.innerHTML = '<p class="empty-state">完了したタスクのデータがありません。</p>';
        return;
    }

    const tagColorMap = {
        '講義': 'var(--tag-lecture)',
        '勉強・課題': 'var(--tag-study)',
        '趣味・遊び': 'var(--tag-hobby)',
        '運動': 'var(--tag-exercise)',
        'タスク': 'var(--tag-task)',
        'カレンダー': 'var(--tag-calendar)'
    };

    // Build HTML in one pass, set innerHTML once
    statsContent.innerHTML = sortedTags.map(tag => {
        const mins = tagCounts[tag];
        const hours = Math.floor(mins / 60);
        const m = mins % 60;
        const timeStr = hours > 0 ? `${hours}時間 ${m}分` : `${m}分`;
        const percent = Math.round((mins / totalMins) * 100);
        const color = tagColorMap[tag] || 'var(--tag-task)';
        return `<div class="stat-item">
            <div class="stat-header"><span>${tag}</span><span>${timeStr} (${percent}%)</span></div>
            <div class="stat-bar-bg"><div class="stat-bar-fill" style="width:${percent}%;background:${color}"></div></div>
        </div>`;
    }).join('');
}

// --- Timer Bar Chart ---
let timerChartDays = 7;


function renderTimerBarChart() {
    const container = document.getElementById('timer-bar-chart');
    if (!container) return;

    // Pre-group record schedules by date in one pass instead of O(n×days) repeated scans
    const recordMinsByDate = {};
    state.schedules.forEach(s => {
        if (s.tag !== 'record' || !s.startTime || !s.endTime) return;
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        let mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins < 0) mins += 1440;
        recordMinsByDate[s.date] = (recordMinsByDate[s.date] || 0) + Math.max(0, mins);
    });

    const data = [];
    const today = new Date();
    for (let i = timerChartDays - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleDateString('en-CA');
        const minutes = recordMinsByDate[dateStr] || 0;
        const dow = ['日','月','火','水','木','金','土'][d.getDay()];
        data.push({ minutes, day: String(d.getDate()), dow, isToday: i === 0 });
    }

    const maxMins = Math.max(...data.map(d => d.minutes), 30);
    const maxH    = Math.ceil(maxMins / 60);
    const yMax    = maxH * 60;
    const totalMins = data.reduce((s, d) => s + d.minutes, 0);
    const tH = Math.floor(totalMins / 60), tM = totalMins % 60;
    const totalStr = tH > 0 ? `${tH}時間${tM > 0 ? tM + '分' : ''}` : `${tM}分`;
    let streak = 0;
    for (let i = data.length - 1; i >= 0; i--) { if (data[i].minutes > 0) streak++; else break; }

    const CHART_H = 150;
    const Y_W = 34;
    const yStepH = maxH <= 2 ? 1 : maxH <= 6 ? 2 : Math.ceil(maxH / 4);
    const yTicks = [];
    for (let h = 0; h <= maxH; h += yStepH) yTicks.push(h);
    if (yTicks[yTicks.length - 1] !== maxH) yTicks.push(maxH);

    // Y-axis labels (from bottom)
    const yLabelsHtml = yTicks.map(h => {
        const px = Math.round((h / maxH) * CHART_H);
        return `<div style="position:absolute;right:4px;bottom:${px}px;font-size:0.62rem;color:var(--text-secondary);transform:translateY(50%);white-space:nowrap">${h}h</div>`;
    }).join('');

    // Grid lines inside bars area (position:absolute)
    const gridHtml = yTicks.map(h => {
        const px = Math.round((h / maxH) * CHART_H);
        return `<div style="position:absolute;left:0;right:0;bottom:${px}px;height:1px;background:rgba(255,255,255,0.06);pointer-events:none"></div>`;
    }).join('');

    const showDow = timerChartDays <= 14;
    // Bar columns and x-labels rendered separately
    const barColsHtml = data.map(d => {
        const barPx = d.minutes > 0 ? Math.max(3, Math.round((d.minutes / yMax) * CHART_H)) : 0;
        const h = Math.floor(d.minutes / 60), m = d.minutes % 60;
        const tip = d.minutes > 0 ? (h > 0 ? `${h}h${m > 0 ? m + 'm' : ''}` : `${m}m`) : '';
        return `<div class="cbc${d.isToday ? ' cbc-today' : ''}">
            ${tip ? `<div class="c-tip">${tip}</div>` : ''}
            <div class="c-bar" style="height:${barPx}px"></div>
        </div>`;
    }).join('');

    const xLabelsHtml = data.map(d =>
        `<div class="cxl${d.isToday ? ' cxl-today' : ''}">${d.day}${showDow ? `<br><span style="opacity:.6;font-size:0.58rem">${d.dow}</span>` : ''}</div>`
    ).join('');

    container.innerHTML = `
        <div class="chart-meta-row">
            <span class="chart-total-val">${totalStr}</span>
            ${streak >= 2 ? `<span class="chart-streak-badge">🔥 ${streak}日連続</span>` : ''}
        </div>
        <div style="display:flex;align-items:flex-end;gap:0">
            <div style="width:${Y_W}px;height:${CHART_H}px;position:relative;flex-shrink:0">${yLabelsHtml}</div>
            <div style="flex:1;overflow-x:auto">
                <div style="display:flex;flex-direction:column;min-width:100%">
                    <div class="c-bars-area" style="height:${CHART_H}px;position:relative">${gridHtml}${barColsHtml}</div>
                    <div class="c-xlabels-row">${xLabelsHtml}</div>
                </div>
            </div>
        </div>`;
}

// --- Calorie Tracking ---
function renderCalorieSection() {
    const today = getTodayString();
    if (!state.calories) state.calories = {};
    if (!state.calories[today]) state.calories[today] = [];
    const records = state.calories[today];
    const total   = records.reduce((s, r) => s + r.kcal, 0);
    const target  = state.settings.calorieTarget || 2000;
    const pct     = Math.min(110, Math.round((total / target) * 100));
    const remain  = target - total;
    const fillColor = pct > 105 ? 'var(--danger-color)' : pct > 85 ? '#f59e0b' : '#10b981';

    const targetEl = document.getElementById('calorie-target-input');
    if (targetEl && !targetEl.matches(':focus')) targetEl.value = target;

    const sumEl = document.getElementById('calorie-today-summary');
    if (sumEl) {
        sumEl.innerHTML = `
            <div class="cal-summary">
                <div class="cal-numbers">
                    <span class="cal-consumed">${total}</span>
                    <span class="cal-sep"> / ${target} kcal</span>
                </div>
                <div class="cal-bar-bg"><div class="cal-bar-fill" style="width:${Math.min(100,pct)}%; background:${fillColor}"></div></div>
                <div class="cal-remain">${remain >= 0 ? `あと ${remain} kcal` : `超過 ${-remain} kcal`}</div>
            </div>`;
    }

    const listEl = document.getElementById('calorie-records-list');
    if (listEl) {
        listEl.innerHTML = records.length === 0
            ? '<p class="empty-state" style="font-size:0.85rem; padding:0.5rem 0;">まだ記録がありません</p>'
            : records.map(r => `
                <div class="cal-record">
                    <span class="cal-record-name">${r.label}</span>
                    <span class="cal-record-kcal">${r.kcal} kcal</span>
                    <button class="cal-del-btn" onclick="deleteCalorieRecord('${today}','${r.id}')">✕</button>
                </div>`).join('');
    }

    renderCalorieChart();
}

function renderCalorieChart() {
    const container = document.getElementById('calorie-chart');
    if (!container) return;
    const target = state.settings.calorieTarget || 2000;

    const data = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleDateString('en-CA');
        const recs = state.calories[dateStr] || [];
        const kcal = recs.reduce((s, r) => s + r.kcal, 0);
        const dow = ['日','月','火','水','木','金','土'][d.getDay()];
        data.push({ kcal, day: String(d.getDate()), dow, isToday: i === 0 });
    }

    const maxKcal = Math.max(...data.map(d => d.kcal), target * 1.1);
    const CHART_H = 120;
    const targetPx = Math.round((target / maxKcal) * CHART_H);

    const barColsHtml = data.map(d => {
        const barPx = d.kcal > 0 ? Math.max(3, Math.round((d.kcal / maxKcal) * CHART_H)) : 0;
        const color = d.kcal > target ? 'var(--danger-color)' : '#10b981';
        return `<div class="cbc${d.isToday ? ' cbc-today' : ''}">
            ${d.kcal > 0 ? `<div class="c-tip">${d.kcal}</div>` : ''}
            <div class="c-bar" style="height:${barPx}px;background:${color};background-image:none"></div>
        </div>`;
    }).join('');

    const xLabelsHtml = data.map(d =>
        `<div class="cxl${d.isToday ? ' cxl-today' : ''}">${d.day}<br><span style="opacity:.6;font-size:0.58rem">${d.dow}</span></div>`
    ).join('');

    // Target line and grid lines inside bars area
    const targetLine = `<div style="position:absolute;left:0;right:0;bottom:${targetPx}px;border-top:1.5px dashed rgba(245,158,11,0.7);pointer-events:none">
        <span style="position:absolute;right:2px;top:-12px;font-size:0.58rem;color:#f59e0b;white-space:nowrap">目標 ${target}</span>
    </div>`;

    container.innerHTML = `
        <div style="display:flex;flex-direction:column">
            <div class="c-bars-area" style="height:${CHART_H}px;position:relative">${targetLine}${barColsHtml}</div>
            <div class="c-xlabels-row">${xLabelsHtml}</div>
        </div>`;
}

function addCalorieRecord() {
    const labelEl  = document.getElementById('calorie-label-input');
    const amountEl = document.getElementById('calorie-amount-input');
    if (!labelEl || !amountEl) return;
    const label = labelEl.value.trim() || '食事';
    const kcal  = parseInt(amountEl.value);
    if (!kcal || kcal <= 0) { amountEl.focus(); return; }
    const today = getTodayString();
    if (!state.calories) state.calories = {};
    if (!state.calories[today]) state.calories[today] = [];
    state.calories[today].push({ id: generateId(), label, kcal });
    labelEl.value = '';
    amountEl.value = '';
    labelEl.focus();
    saveData();
    renderCalorieSection();
}

function deleteCalorieRecord(dateStr, id) {
    if (!state.calories[dateStr]) return;
    state.calories[dateStr] = state.calories[dateStr].filter(r => r.id !== id);
    saveData();
    renderCalorieSection();
}

// --- Expense Tracking ---
function renderExpenseSection() {
    const today = getTodayString();
    if (!state.expenses) state.expenses = {};
    if (!state.expenses[today]) state.expenses[today] = [];
    const records = state.expenses[today];
    const total   = records.reduce((s, r) => s + r.amount, 0);
    const budget  = state.settings.expenseBudget || 3000;
    const pct     = Math.min(110, Math.round((total / budget) * 100));
    const remain  = budget - total;
    const fillColor = pct > 105 ? 'var(--danger-color)' : pct > 85 ? '#f59e0b' : '#10b981';

    const budgetEl = document.getElementById('expense-budget-input');
    if (budgetEl && !budgetEl.matches(':focus')) budgetEl.value = budget;

    const sumEl = document.getElementById('expense-today-summary');
    if (sumEl) {
        sumEl.innerHTML = `
            <div class="cal-summary">
                <div class="cal-numbers">
                    <span class="cal-consumed">¥${total.toLocaleString()}</span>
                    <span class="cal-sep"> / ¥${budget.toLocaleString()}</span>
                </div>
                <div class="cal-bar-bg"><div class="cal-bar-fill" style="width:${pct}%; background:${fillColor};"></div></div>
                <p class="cal-remain">${remain >= 0 ? `残り ¥${remain.toLocaleString()}` : `¥${Math.abs(remain).toLocaleString()} オーバー`}</p>
            </div>`;
    }

    const listEl = document.getElementById('expense-records-list');
    if (listEl) {
        listEl.innerHTML = records.length === 0
            ? '<p class="empty-state" style="font-size:0.85rem; padding:0.5rem 0;">まだ記録がありません</p>'
            : records.map(r => `
                <div class="cal-record">
                    <span class="cal-record-name">${r.label}</span>
                    <span class="cal-record-kcal">¥${r.amount.toLocaleString()}</span>
                    <button class="cal-del-btn" onclick="deleteExpenseRecord('${today}','${r.id}')">✕</button>
                </div>`).join('');
    }

    renderExpenseChart();
}

function renderExpenseChart() {
    const container = document.getElementById('expense-chart');
    if (!container) return;
    const budget = state.settings.expenseBudget || 3000;

    const data = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleDateString('en-CA');
        const recs = (state.expenses && state.expenses[dateStr]) || [];
        const amount = recs.reduce((s, r) => s + r.amount, 0);
        const dow = ['日','月','火','水','木','金','土'][d.getDay()];
        data.push({ amount, day: String(d.getDate()), dow, isToday: i === 0 });
    }

    const maxVal = Math.max(...data.map(d => d.amount), budget, 1);

    const barsHtml = data.map(d => {
        const barH = Math.round((d.amount / maxVal) * 80);
        const barColor = d.amount > budget ? 'var(--danger-color)' : d.amount > budget * 0.85 ? '#f59e0b' : 'linear-gradient(to top, #6366f1, #818cf8)';
        return `<div class="cbc${d.isToday ? ' cbc-today' : ''}">
            <span class="c-tip">¥${d.amount.toLocaleString()}</span>
            <div class="c-bar" style="height:${barH}px; background:${barColor};"></div>
        </div>`;
    }).join('');

    const xlabels = data.map(d =>
        `<div class="cxl${d.isToday ? ' cxl-today' : ''}">${d.dow}<br>${d.day}</div>`
    ).join('');

    container.innerHTML = `
        <div style="height:80px;" class="c-bars-area">${barsHtml}</div>
        <div class="c-xlabels-row">${xlabels}</div>`;
}

function addExpenseRecord() {
    const labelEl  = document.getElementById('expense-label-input');
    const amountEl = document.getElementById('expense-amount-input');
    if (!labelEl || !amountEl) return;
    const label  = labelEl.value.trim() || '支出';
    const amount = parseInt(amountEl.value);
    if (!amount || amount <= 0) { amountEl.focus(); return; }
    const today = getTodayString();
    if (!state.expenses) state.expenses = {};
    if (!state.expenses[today]) state.expenses[today] = [];
    state.expenses[today].push({ id: generateId(), label, amount });
    labelEl.value = '';
    amountEl.value = '';
    labelEl.focus();
    saveData();
    renderExpenseSection();
}

function deleteExpenseRecord(dateStr, id) {
    if (!state.expenses || !state.expenses[dateStr]) return;
    state.expenses[dateStr] = state.expenses[dateStr].filter(r => r.id !== id);
    saveData();
    renderExpenseSection();
}

// --- Weekly Schedule Logic ---
function renderWeeklySchedule() {
    const grid = document.getElementById('weekly-grid');
    if (!grid) return;

    grid.innerHTML = '';
    
    const isMobile = document.body.classList.contains('mobile-layout');
    
    if (isMobile) {
        document.getElementById('schedule-week-display').textContent = 
            currentWeekStart.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
    } else {
        const weekStart = getMonday(currentWeekStart);
        const endOfWeek = new Date(weekStart);
        endOfWeek.setDate(endOfWeek.getDate() + 6);
        document.getElementById('schedule-week-display').textContent = 
            `${weekStart.getFullYear()}年 ${weekStart.getMonth()+1}月${weekStart.getDate()}日 〜 ${endOfWeek.getMonth()+1}月${endOfWeek.getDate()}日`;
    }

    // Fixed height constants for alignment (JS controls height, not CSS)
    const HEADER_H = 60;  // header area height in px
    const TASKS_H  = 120; // tasks area height in px

    // Time column with labels inside its own timeline
    const timeCol = document.createElement('div');
    timeCol.className = 'weekly-time-column';
    // Header and tasks-area spacer use same height constants as data columns
    let timeColHTML = `<div class="weekly-header" style="height:${HEADER_H}px; box-sizing:border-box; border-bottom:none;"></div>`;
    timeColHTML   += `<div style="height:${TASKS_H}px; box-sizing:border-box; border-bottom:1px solid var(--panel-border);"></div>`;
    timeColHTML   += `<div class="weekly-timeline" style="background:transparent; border-right:1px solid var(--panel-border);">` ;
    for (let h = 5; h <= 28; h++) {
        const displayH = h % 24;
        timeColHTML += `<div class="time-slot-label" style="top:${(h-5)*60}px">${displayH}:00</div>`;
    }
    timeColHTML += '</div>';
    timeCol.innerHTML = timeColHTML;
    grid.appendChild(timeCol);

    const todayStr = getTodayString();
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    
    const baseDate = isMobile ? currentWeekStart : getMonday(currentWeekStart);
    const numDays = isMobile ? 1 : 7;
    
    for (let i = 0; i < numDays; i++) {
        const currentDate = new Date(baseDate);
        currentDate.setDate(currentDate.getDate() + i);
        const dateStr = currentDate.toLocaleDateString('en-CA');
        const isToday = dateStr === todayStr;
        const dayLabel = days[currentDate.getDay()];

        const col = document.createElement('div');
        col.className = 'weekly-column';
        
        // Header
        const header = document.createElement('div');
        header.className = `weekly-header ${isToday ? 'today' : ''}`;
        header.innerHTML = `<div class="weekly-day">${dayLabel}</div><div class="weekly-date">${currentDate.getDate()}</div>`;
        col.appendChild(header);

        // Tasks container — height is set via JS to match time-col-spacer exactly
        const tasksDiv = document.createElement('div');
        tasksDiv.className = 'weekly-tasks';
        tasksDiv.style.height = TASKS_H + 'px';
        tasksDiv.style.overflowY = 'auto';
        tasksDiv.style.boxSizing = 'border-box';
        
        const dayTasks = state.tasks.filter(t => t.date === dateStr);
        dayTasks.forEach(task => {
            // Find matching timer record for this task on this date
            const record = task.completed
                ? state.schedules.find(s => s.date === dateStr && s.tag === 'record' && s.title === `⏱ ${task.text}`)
                : null;

            const tDiv = document.createElement('div');
            tDiv.className = `weekly-task-item ${task.completed ? 'completed' : ''}`;
            if (record) tDiv.style.alignItems = 'flex-start';

            tDiv.innerHTML = `
                <input type="checkbox" ${task.completed ? 'checked' : ''} style="flex-shrink:0;${record ? ' margin-top:2px;' : ''}"
                    onchange="toggleTask('${task.id}'); if(document.getElementById('view-schedule').classList.contains('active')) renderWeeklySchedule();">
                <div style="flex:1; min-width:0;">
                    <div class="weekly-task-text" title="${task.text}">${task.text}</div>
                    ${record ? `<div class="task-record-time">⏱ ${record.startTime}–${record.endTime}</div>` : ''}
                </div>
            `;
            tasksDiv.appendChild(tDiv);
        });

        // Header height also controlled by JS for precise alignment
        header.style.height = HEADER_H + 'px';
        header.style.boxSizing = 'border-box';

        col.appendChild(tasksDiv);

        // Timeline container
        const timelineDiv = document.createElement('div');
        timelineDiv.className = 'weekly-timeline';
        
        const daySchedules = state.schedules.filter(s => s.date === dateStr);
        
        const tagColorMap = {
            '講義': 'rgba(59, 130, 246, 0.4)',
            '勉強・課題': 'rgba(16, 185, 129, 0.4)',
            '趣味・遊び': 'rgba(245, 158, 11, 0.4)',
            '運動': 'rgba(236, 72, 153, 0.4)',
            'タスク': 'rgba(139, 92, 246, 0.4)',
            'カレンダー': 'rgba(239, 68, 68, 0.4)',
            'カレンダー2': 'rgba(251, 146, 60, 0.4)',
            'カレンダー3': 'rgba(34, 211, 238, 0.4)',
            'カレンダー4': 'rgba(167, 139, 250, 0.4)',
            'カレンダー5': 'rgba(52, 211, 153, 0.4)',
            'カレンダー6': 'rgba(248, 113, 113, 0.4)',
            'record': 'rgba(14, 165, 233, 0.6)'
        };

        const tagBorderMap = {
            '講義': '#3b82f6',
            '勉強・課題': '#10b981',
            '趣味・遊び': '#f59e0b',
            '運動': '#ec4899',
            'タスク': '#8b5cf6',
            'カレンダー': '#ef4444',
            'カレンダー2': '#fb923c',
            'カレンダー3': '#22d3ee',
            'カレンダー4': '#a78bfa',
            'カレンダー5': '#34d399',
            'カレンダー6': '#f87171',
            'record': '#0ea5e9'
        };

        daySchedules.forEach(sched => {
            const [sh, sm] = sched.startTime.split(':').map(Number);
            const [eh, em] = sched.endTime.split(':').map(Number);
            
            let startMins = sh * 60 + sm;
            let endMins = eh * 60 + em;
            
            if (sh < 5) startMins += 24 * 60;
            if (eh < 5) endMins += 24 * 60;
            if (endMins < startMins) endMins = startMins + 60;

            const top = startMins - (5 * 60);
            const height = endMins - startMins;

            const block = document.createElement('div');
            block.className = `schedule-block ${sched.tag === 'record' ? 'record-block' : ''}`;
            block.style.top = `${top}px`;
            block.style.height = `${height}px`;
            block.style.backgroundColor = tagColorMap[sched.tag] || tagColorMap['タスク'];
            block.style.borderLeftColor = tagBorderMap[sched.tag] || tagBorderMap['タスク'];

            block.innerHTML = `
                <div class="schedule-title" title="${sched.title}">${sched.title}</div>
                <div class="schedule-time">${sched.startTime} - ${sched.endTime}</div>
                ${sched.memo ? `<div class="schedule-memo" title="${sched.memo}">${sched.memo}</div>` : ''}
            `;
            timelineDiv.appendChild(block);
        });

        col.appendChild(timelineDiv);
        grid.appendChild(col);
    }
}

// --- Diary ---

function renderDiaryView(dateStr) {
    if (!dateStr) return;
    const panel = document.getElementById('diary-panel');
    if (!panel) return;

    const entry = state.diary[dateStr] || {};
    const localNote = entry.localNote || '';

    const dateDisplay = new Date(dateStr + 'T12:00:00').toLocaleDateString('ja-JP', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });

    const canTranscribe = gisInited || !!(window.google && state.settings?.clientId);

    // Build TRANSCRIBED-entries list (dates that have a Doc heading anchor).
    // Local notes are wiped nightly, so the log now reflects transcribed history.
    const transcribedEntries = Object.entries(state.diary)
        .filter(([d, e]) => e && e.docHeadingId && d !== dateStr)
        .sort(([a], [b]) => b.localeCompare(a));

    const logListHTML = transcribedEntries.length > 0
        ? transcribedEntries.map(([d, e]) => {
            const dDisplay = new Date(d + 'T12:00:00').toLocaleDateString('ja-JP', {
                year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
            });
            const jumpUrl = `https://docs.google.com/document/d/${DIARY_DOC_ID}/edit#heading=h.${e.docHeadingId}`;
            return `<div class="diary-log-item" data-date="${d}">
                <div class="diary-log-meta">
                    <span class="diary-log-date">${dDisplay}</span>
                    <a href="${jumpUrl}" target="_blank" rel="noopener" class="diary-log-jump" onclick="event.stopPropagation()">📄 開く ↗</a>
                </div>
                <div class="diary-log-preview">転記済み</div>
            </div>`;
        }).join('')
        : '<p class="empty-state" style="padding: 0.75rem 0; font-size: 0.85rem; margin: 0;">転記済みの日記はまだありません</p>';

    panel.innerHTML = `
        <h4 class="diary-date-heading">${dateDisplay}</h4>

        <div class="diary-note-section">
            <label class="diary-note-label">📝 ローカルメモ <span class="diary-note-hint">（オフライン対応・自動保存）</span></label>
            <textarea id="diary-local-note" class="diary-textarea" rows="12"
                placeholder="今日学んだこと、気づいたこと、明日試すこと...">${localNote}</textarea>
            <div class="diary-note-footer">
                <span id="diary-save-status" class="diary-save-status">保存しました ✓</span>
                <div class="diary-footer-actions">
                    ${entry.docHeadingId
                      ? `<a href="https://docs.google.com/document/d/${DIARY_DOC_ID}/edit#heading=h.${entry.docHeadingId}" target="_blank" rel="noopener" class="btn secondary diary-open-btn">📄 転記先 ↗</a>`
                      : ''}
                    <a href="https://docs.google.com/document/d/${DIARY_DOC_ID}/edit" target="_blank" rel="noopener" class="btn secondary diary-open-btn">開く ↗</a>
                    <button id="btn-transcribe-diary" class="btn secondary" ${canTranscribe ? '' : 'disabled title="Google Client IDを設定してください"'}>転記する</button>
                    <button id="btn-save-diary-note" class="btn primary">保存</button>
                </div>
            </div>
        </div>

        <div class="diary-log-section">
            <h4 class="diary-log-heading">📋 過去のログ</h4>
            <div class="diary-log-list" id="diary-log-list">
                ${logListHTML}
            </div>
        </div>
    `;

    // Transcribe to Google Doc
    const transcribeBtn = document.getElementById('btn-transcribe-diary');
    if (transcribeBtn) {
        transcribeBtn.addEventListener('click', () => transcribeDiaryToDoc(dateStr));
    }

    // Save local note
    const saveBtn = document.getElementById('btn-save-diary-note');
    const noteArea = document.getElementById('diary-local-note');
    const saveStatus = document.getElementById('diary-save-status');

    function saveDiaryNote() {
        if (!state.diary[dateStr]) state.diary[dateStr] = {};
        state.diary[dateStr].localNote = noteArea.value;
        saveData();
        if (saveStatus) {
            saveStatus.style.opacity = '1';
            setTimeout(() => { saveStatus.style.opacity = '0'; }, 2000);
        }
    }

    if (saveBtn) saveBtn.addEventListener('click', saveDiaryNote);

    // Ctrl+S / Cmd+S shortcut + auto-save
    if (noteArea) {
        let _autoSaveTimer = null;
        noteArea.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                saveDiaryNote();
            }
        });
        noteArea.addEventListener('input', () => {
            clearTimeout(_autoSaveTimer);
            _autoSaveTimer = setTimeout(saveDiaryNote, 3000);
        });
    }

    // Past log navigation: click an entry to navigate to that date
    const logList = document.getElementById('diary-log-list');
    if (logList) {
        logList.addEventListener('click', e => {
            // Allow the inline 'open in Doc' link to navigate without switching date
            if (e.target.closest('.diary-log-jump')) return;
            const item = e.target.closest('.diary-log-item');
            if (!item) return;
            const d = item.dataset.date;
            if (!d) return;
            const picker = document.getElementById('diary-date-picker');
            if (picker) picker.value = d;
            renderDiaryView(d);
        });
    }
}

async function transcribeDiaryToDoc(dateStr) {
    const btn = document.getElementById('btn-transcribe-diary');
    if (btn) { btn.disabled = true; btn.textContent = '転記中...'; }

    const entry = state.diary[dateStr] || {};
    const noteContent = (entry.localNote || '').trim();
    if (!noteContent) {
        alert('転記するメモがありません。先にローカルメモを入力してください。');
        if (btn) { btn.disabled = false; btn.textContent = '転記する'; }
        return;
    }

    if (!driveTokenClient) {
        if (!window.google) {
            alert('Google Identity Services の読み込みに失敗しました。ページを再読み込みしてください。');
            if (btn) { btn.disabled = false; btn.textContent = '転記する'; }
            return;
        }
        if (!state.settings?.clientId) {
            alert('設定画面でGoogle Client IDを入力してください。');
            if (btn) { btn.disabled = false; btn.textContent = '転記する'; }
            return;
        }
        initGAPI();
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (!driveTokenClient) {
        alert('Docs APIの初期化に失敗しました。ページを再読み込みしてください。');
        if (btn) { btn.disabled = false; btn.textContent = '転記する'; }
        return;
    }

    if (window.gapi && !gapi.client) {
        await new Promise(resolve => gapi.load('client', resolve));
    }

    const doTranscribe = async () => {
        try {
            if (!window.gapi) throw new Error('gapi が利用できません');
            if (!gapi.client) {
                await new Promise(resolve => gapi.load('client', resolve));
            }
            if (!gapi.client.docs) {
                await gapi.client.load('docs', 'v1');
            }

            // Get the document to find the end index for insertion
            const docRes = await gapi.client.docs.documents.get({ documentId: DIARY_DOC_ID });
            const bodyContent = docRes.result.body.content;
            const lastElement = bodyContent[bodyContent.length - 1];
            // Insert before the final newline character (endIndex - 1)
            const insertIndex = lastElement.endIndex - 1;

            const dateDisplay = new Date(dateStr + 'T12:00:00').toLocaleDateString('ja-JP', {
                year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
            });
            const insertText = `\n${dateDisplay}\n${noteContent}\n`;

            // Date line range (so we can style it as a heading for in-doc anchor)
            const dateLineStart = insertIndex + 1;                 // after the leading \n
            const dateLineEnd   = dateLineStart + dateDisplay.length + 1; // include trailing \n

            await gapi.client.docs.documents.batchUpdate({
                documentId: DIARY_DOC_ID,
                resource: {
                    requests: [
                        { insertText: { location: { index: insertIndex }, text: insertText } },
                        {
                            updateParagraphStyle: {
                                range: { startIndex: dateLineStart, endIndex: dateLineEnd },
                                paragraphStyle: { namedStyleType: 'HEADING_2' },
                                fields: 'namedStyleType'
                            }
                        }
                    ]
                }
            });

            // Fetch the doc again to grab the auto-generated heading ID for this paragraph.
            // We look for the LAST heading whose text matches the date we just inserted.
            try {
                const docAfter = await gapi.client.docs.documents.get({ documentId: DIARY_DOC_ID });
                const elems = docAfter.result.body.content || [];
                let foundHeadingId = null;
                for (let i = elems.length - 1; i >= 0; i--) {
                    const p = elems[i].paragraph;
                    if (!p || !p.paragraphStyle || !p.paragraphStyle.headingId) continue;
                    const txt = (p.elements || [])
                        .map(el => (el.textRun && el.textRun.content) || '')
                        .join('')
                        .replace(/\n/g, '')
                        .trim();
                    if (txt === dateDisplay) {
                        foundHeadingId = p.paragraphStyle.headingId;
                        break;
                    }
                }
                if (foundHeadingId) {
                    if (!state.diary[dateStr]) state.diary[dateStr] = {};
                    state.diary[dateStr].docHeadingId = foundHeadingId;
                    state.diary[dateStr].transcribedAt = new Date().toISOString();
                    saveData();
                }
            } catch (idErr) {
                console.warn('Failed to capture heading ID (transcription succeeded):', idErr);
            }

            alert(`転記しました！\n${dateDisplay} の日記をドキュメントに追加しました。`);

            // Refresh diary view so the "転記先へ ↗" link appears for the current date
            if (document.getElementById('view-diary')?.classList.contains('active')) {
                renderDiaryView(dateStr);
            }
            if (btn) { btn.disabled = false; btn.textContent = '転記する'; }
        } catch(e) {
            console.error('Diary transcribe failed:', e);
            const status = e?.status || e?.result?.error?.code;
            const apiMsg = e?.result?.error?.message || '';
            const reason = e?.result?.error?.errors?.[0]?.reason || '';
            let msg = apiMsg || e?.message || '不明なエラー';
            if (status) msg = `[${status}] ` + msg;
            if (reason) msg += `\n(reason: ${reason})`;

            // Specific guidance: "API is blocked" — usually means API key restrictions or API not enabled
            const isApiBlocked = /are blocked|API.*not enabled|accessNotConfigured/i.test(apiMsg + ' ' + reason);
            if (isApiBlocked) {
                const cid = state.settings?.clientId || '';
                const projNum = (cid.match(/^(\d+)-/) || [])[1];
                const enableUrl = projNum
                    ? `https://console.cloud.google.com/apis/library/docs.googleapis.com?project=${projNum}`
                    : 'https://console.cloud.google.com/apis/library/docs.googleapis.com';
                const credUrl = projNum
                    ? `https://console.cloud.google.com/apis/credentials?project=${projNum}`
                    : 'https://console.cloud.google.com/apis/credentials';
                msg += '\n\n──────────\n'
                    + '【考えられる原因】\n'
                    + '①「Google Docs API」がプロジェクトで未有効化\n'
                    + '② APIキーに「API制限」が掛かっていて Docs API が許可リストに無い\n\n'
                    + '【対処手順】\n'
                    + '(A) API ライブラリで「Google Docs API」を有効化:\n'
                    + '    ' + enableUrl + '\n\n'
                    + '(B) APIキーの「APIの制限」を見直す:\n'
                    + '    ' + credUrl + '\n'
                    + '    → 使用中のAPIキーを開いて、「キーを制限しない」または\n'
                    + '       許可APIリストに「Google Docs API」を追加して保存\n\n'
                    + '(A)(B) いずれかを行った後、1〜2分待って再度「転記する」を押してください。\n'
                    + 'OKを押すと、まずAPIライブラリを新規タブで開きます。';
                alert('転記に失敗しました。\n' + msg);
                window.open(enableUrl, '_blank', 'noopener');
                window.open(credUrl, '_blank', 'noopener');
            } else if (status === 401 || status === 403) {
                msg += '\n\nヒント: Googleアカウントの権限を再認可してみてください。';
                alert('転記に失敗しました。\n' + msg);
            } else {
                alert('転記に失敗しました。\n' + msg);
            }
            if (btn) { btn.disabled = false; btn.textContent = '転記する'; }
        }
    };

    driveAuthCallback = doTranscribe;
    driveTokenClient.requestAccessToken({ prompt: '' });
}

// ============================================================
// NEW FEATURE MODULES (v2.0+)
//   - Daily Check-in chips
//   - Pomodoro + Browser Notifications + Focus Score
//   - Bidirectional Google Calendar + DND time-blocking
//   - Weekly Review + Streak + Monthly Highlights
//   - AI Assist (Anthropic API with heuristic fallback)
//   - Health (mood / sleep / water / exercise)
//   - Goals (long-term goals with milestones)
//   - Smart Templates + Voice Input + Mobile Quick FAB
// ============================================================

// ──────────────────────────────────────────────────────────
// Extended state initialization (idempotent)
// ──────────────────────────────────────────────────────────
function ensureNewState() {
    if (!state.health) state.health = {};       // { 'YYYY-MM-DD': { mood, moodNote, sleepHours, sleepQuality, waterCups, exerciseMins, exerciseType } }
    if (!state.goals) state.goals = [];         // [{ id, title, target, current, unit, deadline, linkedTag, milestonesNotified }]
    if (!state.weeklyReviews) state.weeklyReviews = {};
    if (!state.templates) state.templates = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    if (!state.streak) state.streak = { currentStreak: 0, longestStreak: 0, lastActiveDate: '' };
    if (!state.notifications) state.notifications = {
        taskBefore: true, timerEnd: true, diaryReminder: true,
        dailySummary: true, pomodoro: true,
        firedToday: {} // date-keyed map of which alerts have fired today
    };
    if (!state.principles) state.principles = { goals: [], words: [] };
    // Defensive: protect against fresh-install state where loadData's
    // 'if saved' block never ran, leaving these undefined.
    if (!state.calories) state.calories = {};
    if (!state.expenses) state.expenses = {};
    if (!state.diary) state.diary = {};
    if (!state.memos) state.memos = [];
    if (!state.pausedTimers) state.pausedTimers = [];
    if (!state.aiSettings) state.aiSettings = {
        provider: 'claude',          // 'claude' | 'ollama' | 'openai-compatible'
        apiKey: '',                  // Anthropic API key
        localUrl: 'http://localhost:11434',
        localModel: 'llama3.2',
        enabled: false
    };
    // Migrate older shape (only apiKey + enabled) by adding new fields with defaults
    if (state.aiSettings && !state.aiSettings.provider) state.aiSettings.provider = 'claude';
    if (state.aiSettings && state.aiSettings.localUrl == null) state.aiSettings.localUrl = 'http://localhost:11434';
    if (state.aiSettings && state.aiSettings.localModel == null) state.aiSettings.localModel = 'llama3.2';
    if (!state.dailyCheckSettings) state.dailyCheckSettings = {
        mood: true, sleep: true, water: true, exercise: true, diary: true,
        calorie: false, expense: false
    };
    if (!state.timer.pomodoro) state.timer.pomodoro = {
        mode: 'normal',           // 'normal' | 'pomodoro'
        workMins: 25,
        breakMins: 5,
        phase: 'work',            // 'work' | 'break'
        completedCycles: 0,
        phaseStartTime: null      // when current phase started (ms)
    };
    if (!state.timer.focusScore) state.timer.focusScore = { interrupts: 0 };
    if (!state.thermalSystem) state.thermalSystem = {
        initialCondition: '',
        blocks: {
            morning: { content: '実装 60-90分' },
            afternoon: { content: '理論 45分' },
            night: { content: '英語 30分' }
        },
        safeMode: false,
        disturbances: {},
        dailyTouch: {}
    };
    if (state.thermalSystem && !state.thermalSystem.disturbances) state.thermalSystem.disturbances = {};
    if (state.thermalSystem && !state.thermalSystem.dailyTouch) state.thermalSystem.dailyTouch = {};
}

// Wrap original loadData → ensure new state always exists
const _origSaveData = saveData;
const _origLoadData = loadData;
loadData = function() {
    _origLoadData();
    ensureNewState();
    clearOldLocalMemos();
};

// Local memo is a daily scratch buffer — clear notes from any date != today.
// Past entries' other fields (if any) are preserved, just the localNote is erased.
function clearOldLocalMemos() {
    if (!state.diary) return;
    const today = getTodayString();
    let changed = false;
    Object.keys(state.diary).forEach(d => {
        if (d !== today && state.diary[d] && state.diary[d].localNote) {
            state.diary[d].localNote = '';
            changed = true;
        }
    });
    if (changed) {
        // Persist immediately so the cleared state survives reload.
        // (Use _origSaveData if available to avoid re-render churn during init.)
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
    }
}

// ── Optimization: debounce dashboard render via requestAnimationFrame ──
// Multiple saveData() calls in the same frame now coalesce into a single render.
let _dashRenderScheduled = false;
let _dashViewEl = null;
function scheduleDashboardRender() {
    if (_dashRenderScheduled) return;
    if (!_dashViewEl) _dashViewEl = document.getElementById('view-dashboard');
    if (!_dashViewEl || !_dashViewEl.classList.contains('active')) return;
    _dashRenderScheduled = true;
    requestAnimationFrame(() => {
        _dashRenderScheduled = false;
        renderDashboard();
    });
}

// Replace saveData with optimized version. Keep localStorage synchronous
// (so a page refresh right after a change still sees the latest data),
// but render via rAF and conflict cache invalidation.
saveData = function() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        console.warn('localStorage write failed:', e);
    }
    _conflictsCacheVersion++;            // invalidate conflict memo
    scheduleDashboardRender();
    if (currentUser) scheduleCloudSave();
};

// Memoized conflicts (invalidated on every saveData)
let _conflictsCacheVersion = 0;
let _conflictsCache = { version: -1, set: new Set() };

// Patch fetchCloudData merge: include new sections
const _origFetchCloudData = fetchCloudData;
fetchCloudData = async function() {
    await _origFetchCloudData.apply(this, arguments);
    ensureNewState();
    // After loading from cloud, also clear any stale local memos (cloud may have
    // yesterday's note which should now be wiped).
    clearOldLocalMemos();
    // Re-render diary if currently viewing it
    if (document.getElementById('view-diary')?.classList.contains('active')) {
        const picker = document.getElementById('diary-date-picker');
        if (picker) renderDiaryView(picker.value || getTodayString());
    }
};

// Patch saveToCloud to also persist new fields
saveToCloud = async function() {
    if (!db || !currentUser) return;
    try {
        const syncStatus = document.getElementById('sync-status');
        if (syncStatus) {
            syncStatus.textContent = '同期中...';
            syncStatus.style.color = 'var(--text-secondary)';
        }
        const dataToSave = {
            tasks: state.tasks, routines: state.routines, schedules: state.schedules,
            history: state.history, lastDate: state.lastDate, settings: state.settings,
            timer: state.timer, pausedTimers: state.pausedTimers,
            calories: state.calories, expenses: state.expenses,
            memos: state.memos, diary: state.diary,
            health: state.health, goals: state.goals,
            weeklyReviews: state.weeklyReviews, templates: state.templates,
            streak: state.streak, notifications: state.notifications,
            aiSettings: state.aiSettings, dailyCheckSettings: state.dailyCheckSettings,
            principles: state.principles
        };
        await db.collection('users').doc(currentUser.uid).set(dataToSave);
        hasPendingCloudSync = false;
        if (syncStatus) { syncStatus.textContent = '同期済 ✓'; syncStatus.style.color = 'var(--success-color)'; }
        updateNetworkStatusUI();
    } catch (e) {
        console.error("Error saving to cloud", e);
        hasPendingCloudSync = true;
        const syncStatus = document.getElementById('sync-status');
        if (syncStatus) { syncStatus.textContent = '同期失敗 ✕'; syncStatus.style.color = 'var(--danger-color)'; }
        updateNetworkStatusUI();
    }
};

// ──────────────────────────────────────────────────────────
// Daily Check-in chips on dashboard
// ──────────────────────────────────────────────────────────
let _dccBarCache = '';
function renderDailyCheckinBar() {
    const bar = document.getElementById('daily-checkin-bar');
    if (!bar) return;
    const today = getTodayString();
    const h = state.health[today] || {};
    const cfg = state.dailyCheckSettings;
    const diaryDone = !!(state.diary[today] && state.diary[today].localNote && state.diary[today].localNote.trim());
    const calDone   = !!(state.calories && state.calories[today] && state.calories[today].length > 0);
    const expDone   = !!(state.expenses && state.expenses[today] && state.expenses[today].length > 0);
    const moodIcons = { 1:'😢', 2:'😕', 3:'😐', 4:'🙂', 5:'😄' };

    const chips = [];
    if (cfg.calorie) chips.push({
        key: 'calorie', icon: '🍽️',
        label: 'カロリー', value: calDone ? '記録済' : '未入力', done: calDone, view: 'stats'
    });
    if (cfg.expense) chips.push({
        key: 'expense', icon: '💴',
        label: '支出', value: expDone ? '記録済' : '未入力', done: expDone, view: 'stats'
    });

    const newHTML = chips.map(c => `
        <div class="daily-check-chip ${c.done ? 'done' : ''}" onclick="switchView('${c.view}')" title="${c.label}">
            <div class="dcc-icon">${c.icon}</div>
            <div class="dcc-label">${c.label}</div>
            <div class="dcc-value">${c.value}</div>
        </div>
    `).join('');
    // Skip DOM write if nothing changed (cheap diff via cached string)
    if (newHTML === _dccBarCache) return;
    _dccBarCache = newHTML;
    bar.innerHTML = newHTML;
}

// ──────────────────────────────────────────────────────────
// Browser Notifications
// ──────────────────────────────────────────────────────────
function notifPermission() {
    return typeof Notification !== 'undefined' ? Notification.permission : 'denied';
}
async function requestNotifPermission() {
    if (typeof Notification === 'undefined') {
        alert('このブラウザは通知をサポートしていません。');
        return 'denied';
    }
    const p = await Notification.requestPermission();
    updateNotifPermissionStatus();
    return p;
}
function updateNotifPermissionStatus() {
    const el = document.getElementById('notif-permission-status');
    if (!el) return;
    const p = notifPermission();
    if (p === 'granted')      { el.textContent = '✓ 許可済み';    el.style.color = 'var(--success-color)'; }
    else if (p === 'denied')  { el.textContent = '✕ 拒否されています'; el.style.color = 'var(--danger-color)'; }
    else                      { el.textContent = '未許可';        el.style.color = 'var(--text-secondary)'; }
}
function fireNotification(title, body, tag) {
    if (notifPermission() !== 'granted') return;
    try {
        const n = new Notification(title, { body, tag: tag || 'daily-flow', icon: 'icon.jpg', silent: false });
        setTimeout(() => n.close(), 8000);
    } catch (e) { console.warn('Notification failed', e); }
}

// Reset daily fired-once flags at midnight crossing
function maybeResetNotifFlags() {
    const today = getTodayString();
    if (!state.notifications.firedToday || state.notifications.firedToday._date !== today) {
        state.notifications.firedToday = { _date: today };
        // Note: do NOT call saveData here — minor state, persisted on next user action
    }
}

// Main scheduler — called every minute
let _notifCheckInterval = null;
function startNotifScheduler() {
    if (_notifCheckInterval) clearInterval(_notifCheckInterval);
    const tick = () => {
        if (notifPermission() !== 'granted') return;
        maybeResetNotifFlags();
        const fired = state.notifications.firedToday;
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        const today = getTodayString();

        // 1. Upcoming schedule alert (10 min before start)
        if (state.notifications.taskBefore) {
            const todaySchedules = state.schedules.filter(s => s.date === today && s.tag !== 'record');
            todaySchedules.forEach(s => {
                const [sh, sm] = s.startTime.split(':').map(Number);
                const startMs = new Date(today + 'T' + s.startTime + ':00').getTime();
                const diff = startMs - now.getTime();
                if (diff > 9 * 60 * 1000 && diff <= 10 * 60 * 1000 + 30000) {
                    const key = 'pre_' + s.id;
                    if (!fired[key]) {
                        fireNotification('🔔 もうすぐ予定', `${s.startTime} 〜 ${s.title}`, key);
                        fired[key] = true;
                    }
                }
            });
        }

        // 2. Daily summary at 07:00
        if (state.notifications.dailySummary && hhmm === '07:00' && !fired.daily_summary) {
            const todayTasks = state.tasks.filter(t => t.date === today && !t.completed);
            const todaySched = state.schedules.filter(s => s.date === today && s.tag !== 'record');
            fireNotification('☀️ おはようございます',
                `本日のタスク: ${todayTasks.length}件 / 予定: ${todaySched.length}件`, 'daily_summary');
            fired.daily_summary = true;
        }
    };
    tick();
    _notifCheckInterval = setInterval(tick, 60 * 1000);
}

// ──────────────────────────────────────────────────────────
// Pomodoro Timer
// ──────────────────────────────────────────────────────────
let pomodoroAudioCtx = null;
function pomBeep(freq = 880, duration = 0.2) {
    try {
        if (!pomodoroAudioCtx) pomodoroAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = pomodoroAudioCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.15;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        setTimeout(() => { osc.stop(); }, duration * 1000);
    } catch(e) { /* audio disabled */ }
}

function setTimerMode(mode) {
    state.timer.pomodoro.mode = mode;
    const tabs = document.querySelectorAll('.timer-mode-tab');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    const ctrl = document.getElementById('pomodoro-controls');
    if (ctrl) ctrl.style.display = mode === 'pomodoro' ? 'block' : 'none';
    const fs = document.getElementById('focus-score-display');
    if (fs) fs.style.display = mode === 'pomodoro' ? 'inline-flex' : 'none';
    updatePomodoroUI();
    saveData();
}

function updatePomodoroUI() {
    if (!state.timer.pomodoro || !state.timer.focusScore) ensureNewState();
    const p = state.timer.pomodoro;
    const ind = document.getElementById('pom-phase-indicator');
    const cnt = document.getElementById('pom-cycle-counter');
    const workIn = document.getElementById('pom-work-mins');
    const breakIn = document.getElementById('pom-break-mins');
    if (workIn && !workIn.matches(':focus')) workIn.value = p.workMins;
    if (breakIn && !breakIn.matches(':focus')) breakIn.value = p.breakMins;
    if (ind) {
        if (state.timer.isRunning && p.mode === 'pomodoro') {
            ind.textContent = p.phase === 'work' ? '🎯 集中フェーズ' : '☕ 休憩フェーズ';
            ind.className = 'pom-phase-indicator' + (p.phase === 'break' ? ' break' : '');
        } else {
            ind.textContent = '準備中';
            ind.className = 'pom-phase-indicator';
        }
    }
    if (cnt) cnt.textContent = `完了サイクル: ${p.completedCycles}`;
    const fsV = document.getElementById('fs-value');
    const fsI = document.getElementById('fs-interrupts');
    if (fsV) {
        const ints = state.timer.focusScore.interrupts || 0;
        const score = Math.max(0, 100 - ints * 10);
        fsV.textContent = score;
    }
    if (fsI) fsI.textContent = state.timer.focusScore.interrupts || 0;
}

// Pomodoro phase check — uses accumulated work-time (not wall-clock)
// so pauses don't accidentally trigger phase switches.
function checkPomodoroPhase() {
    if (!state.timer.pomodoro) return;  // post-reset transient state
    const p = state.timer.pomodoro;
    if (p.mode !== 'pomodoro' || !state.timer.isRunning) return;
    // Effective work time accumulated so far
    let totalSec = state.timer.accumulatedSeconds;
    if (state.timer.startTime) totalSec += Math.floor((Date.now() - state.timer.startTime) / 1000);
    if (p.phaseStartTotalSec == null) {
        p.phaseStartTotalSec = totalSec;
        return;
    }
    const phaseElapsedSec = totalSec - p.phaseStartTotalSec;
    const targetMins = p.phase === 'work' ? p.workMins : p.breakMins;
    if (phaseElapsedSec >= targetMins * 60) {
        if (p.phase === 'work') {
            p.completedCycles++;
            p.phase = 'break';
            pomBeep(660, 0.3);
            setTimeout(() => pomBeep(880, 0.3), 350);
            if (state.notifications.pomodoro) fireNotification('☕ 休憩タイム', `${p.breakMins}分の休憩を取りましょう。`, 'pom_break');
        } else {
            p.phase = 'work';
            pomBeep(880, 0.3);
            setTimeout(() => pomBeep(660, 0.3), 350);
            if (state.notifications.pomodoro) fireNotification('🎯 集中タイム', `${p.workMins}分の集中を再開しましょう。`, 'pom_work');
        }
        p.phaseStartTotalSec = totalSec;
        saveData();
        updatePomodoroUI();
    }
}

// Patch runTimerInterval to also check Pomodoro phase + record focus interrupts
const _origRunTimerInterval = runTimerInterval;
runTimerInterval = function() {
    if (timerInterval) clearInterval(timerInterval);
    updateTimerDisplay();
    timerInterval = setInterval(() => {
        updateTimerDisplay();
        checkPomodoroPhase();
    }, 1000);
};

// Track interrupts: when isRunning transitions from true → false and not via Finish
let _wasRunning = false;
function trackInterrupt() {
    // Defensive: btn-timer-finish/cancel/reset reassign state.timer to a fresh object,
    // dropping .pomodoro and .focusScore. Re-create them via ensureNewState (idempotent).
    if (!state.timer.pomodoro || !state.timer.focusScore) ensureNewState();
    if (_wasRunning && !state.timer.isRunning && state.timer.pomodoro.mode === 'pomodoro') {
        state.timer.focusScore.interrupts = (state.timer.focusScore.interrupts || 0) + 1;
        updatePomodoroUI();
    }
    _wasRunning = state.timer.isRunning;
}

// Patch syncTimerUI to update Pomodoro elements + track interrupts
const _origSyncTimerUI = syncTimerUI;
syncTimerUI = function() {
    if (!state.timer.pomodoro || !state.timer.focusScore) ensureNewState();
    trackInterrupt();
    _origSyncTimerUI.apply(this, arguments);
    updatePomodoroUI();
    // Initialize phase tracking when timer starts in pomodoro mode
    const p = state.timer.pomodoro;
    if (state.timer.isRunning && p.mode === 'pomodoro' && p.phaseStartTotalSec == null) {
        let totalSec = state.timer.accumulatedSeconds;
        if (state.timer.startTime) totalSec += Math.floor((Date.now() - state.timer.startTime) / 1000);
        p.phaseStartTotalSec = totalSec;
        saveData();
    }
};

// Hook timer Finish: if pomodoro, fire notification
const _origShowTimerCompletionModal = showTimerCompletionModal;
showTimerCompletionModal = function(taskName) {
    if (state.notifications.timerEnd && document.visibilityState !== 'visible') {
        fireNotification('⏱ タスク完了', `${taskName || 'タスク'} を達成しました！`, 'timer_end');
    }
    _origShowTimerCompletionModal.apply(this, arguments);
    // Defensive: original Finish handler reassigned state.timer to a fresh object;
    // re-create pomodoro/focusScore via ensureNewState so subsequent calls don't crash.
    if (!state.timer.pomodoro || !state.timer.focusScore) ensureNewState();
    state.timer.pomodoro.phaseStartTotalSec = null;
    state.timer.pomodoro.phaseStartTime = null;
    state.timer.pomodoro.phase = 'work';
    state.timer.focusScore.interrupts = 0;
    updatePomodoroUI();
};

// ──────────────────────────────────────────────────────────
// Bidirectional Google Calendar + Drag & Drop
// ──────────────────────────────────────────────────────────
const GCAL_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

async function gcalWriteEvent(schedule) {
    if (!gapiInited) return null;
    const token = gapi.client.getToken();
    if (!token) return null;
    try {
        // Check token has write scope; if not, request
        if (!token.scope || !token.scope.includes('calendar.events')) {
            // Request additional scope
            const writeTokenClient = google.accounts.oauth2.initTokenClient({
                client_id: state.settings.clientId,
                scope: GCAL_WRITE_SCOPE,
                callback: () => {}
            });
            await new Promise((resolve, reject) => {
                writeTokenClient.callback = (r) => r.error ? reject(r) : resolve(r);
                writeTokenClient.requestAccessToken({ prompt: '' });
            });
        }
        const tz = 'Asia/Tokyo';
        const startISO = schedule.date + 'T' + schedule.startTime + ':00';
        const endISO = schedule.date + 'T' + schedule.endTime + ':00';
        const body = {
            summary: schedule.title,
            description: schedule.memo || '',
            start: { dateTime: startISO, timeZone: tz },
            end:   { dateTime: endISO,   timeZone: tz }
        };
        if (schedule.gcalId) {
            const res = await gapi.client.calendar.events.update({
                calendarId: 'primary', eventId: schedule.gcalId, resource: body
            });
            return res.result.id;
        } else {
            const res = await gapi.client.calendar.events.insert({
                calendarId: 'primary', resource: body
            });
            schedule.gcalId = res.result.id;
            return res.result.id;
        }
    } catch (e) {
        console.warn('gcalWriteEvent failed:', e);
        return null;
    }
}

// Detect conflicts: two schedules on same date with overlapping times (excluding records)
// Memoized — recomputes only when state changes (saveData bumps the version).
function findConflicts() {
    if (_conflictsCache.version === _conflictsCacheVersion) return _conflictsCache.set;
    const map = {};
    state.schedules.forEach(s => {
        if (s.tag === 'record') return;
        if (!s.startTime || !s.endTime) return;
        if (!map[s.date]) map[s.date] = [];
        map[s.date].push(s);
    });
    const conflictIds = new Set();
    Object.values(map).forEach(arr => {
        // Precompute minute ranges once
        const ranges = arr.map(s => {
            const [sh, sm] = s.startTime.split(':').map(Number);
            const [eh, em] = s.endTime.split(':').map(Number);
            return { id: s.id, start: sh * 60 + sm, end: eh * 60 + em };
        });
        for (let i = 0; i < ranges.length; i++) {
            for (let j = i + 1; j < ranges.length; j++) {
                if (ranges[i].start < ranges[j].end && ranges[j].start < ranges[i].end) {
                    conflictIds.add(ranges[i].id);
                    conflictIds.add(ranges[j].id);
                }
            }
        }
    });
    _conflictsCache = { version: _conflictsCacheVersion, set: conflictIds };
    return conflictIds;
}

// Render unscheduled tasks chips above weekly calendar
function renderUnscheduledTasks() {
    const list = document.getElementById('unscheduled-tasks-list');
    if (!list) return;
    const todayStr = getTodayString();
    // Tasks not yet completed and not appearing in schedule (no record/title match)
    const scheduledTitles = new Set(
        state.schedules.filter(s => s.tag !== 'record').map(s => s.title)
    );
    const unsched = state.tasks.filter(t =>
        !t.completed && t.date >= todayStr && !scheduledTitles.has(t.text)
    );
    if (unsched.length === 0) {
        list.innerHTML = '<span class="unscheduled-empty">全タスクがスケジュール済みです 🎉</span>';
        return;
    }
    list.innerHTML = unsched.map(t => `
        <div class="unscheduled-task-chip" draggable="true" data-task-id="${t.id}">
            ${t.text}${t.duration ? ` <small style="color:var(--text-secondary)">(${t.duration}分)</small>` : ''}
        </div>
    `).join('');
    // Drag handlers
    list.querySelectorAll('.unscheduled-task-chip').forEach(chip => {
        chip.addEventListener('dragstart', (e) => {
            chip.classList.add('dragging');
            e.dataTransfer.setData('text/plain', JSON.stringify({
                type: 'unscheduled-task', taskId: chip.dataset.taskId
            }));
            e.dataTransfer.effectAllowed = 'move';
        });
        chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
    });
}

// Wire DND for the weekly schedule timeline columns
function attachScheduleDND() {
    const grid = document.getElementById('weekly-grid');
    if (!grid) return;
    grid.querySelectorAll('.weekly-timeline').forEach(timeline => {
        timeline.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            timeline.classList.add('drop-target');
        });
        timeline.addEventListener('dragleave', () => timeline.classList.remove('drop-target'));
        timeline.addEventListener('drop', (e) => {
            e.preventDefault();
            timeline.classList.remove('drop-target');
            let data;
            try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
            const rect = timeline.getBoundingClientRect();
            const y = e.clientY - rect.top;
            // y to minutes: timeline starts at 5:00, each minute = 1px (per renderWeeklySchedule)
            let mins = Math.round(y / 15) * 15; // snap to 15-min
            const dateStr = timeline.dataset.date;
            if (!dateStr) return;
            if (data.type === 'unscheduled-task') {
                const task = state.tasks.find(t => t.id === data.taskId);
                if (!task) return;
                const startTotal = 5 * 60 + mins;
                const duration = task.duration && task.duration > 0 ? task.duration : 60;
                const endTotal = startTotal + duration;
                const pad = n => String(n).padStart(2, '0');
                const startStr = `${pad(Math.floor(startTotal / 60) % 24)}:${pad(startTotal % 60)}`;
                const endStr   = `${pad(Math.floor(endTotal / 60) % 24)}:${pad(endTotal % 60)}`;
                state.schedules.push({
                    id: generateId(),
                    title: task.text,
                    date: dateStr,
                    startTime: startStr,
                    endTime: endStr,
                    tag: task.tag || 'タスク',
                    memo: '',
                    linkedTaskId: task.id
                });
                saveData();
                renderWeeklySchedule();
            } else if (data.type === 'move-schedule') {
                const s = state.schedules.find(x => x.id === data.scheduleId);
                if (!s) return;
                const [sh, sm] = s.startTime.split(':').map(Number);
                const [eh, em] = s.endTime.split(':').map(Number);
                const oldDuration = (eh * 60 + em) - (sh * 60 + sm);
                const startTotal = 5 * 60 + mins;
                const endTotal = startTotal + oldDuration;
                const pad = n => String(n).padStart(2, '0');
                s.date = dateStr;
                s.startTime = `${pad(Math.floor(startTotal / 60) % 24)}:${pad(startTotal % 60)}`;
                s.endTime   = `${pad(Math.floor(endTotal / 60) % 24)}:${pad(endTotal % 60)}`;
                saveData();
                if (s.gcalId) gcalWriteEvent(s);
                renderWeeklySchedule();
            }
        });
    });
}

// Patch renderWeeklySchedule to also: tag conflicts, attach DND, store date on timeline, draggable blocks
const _origRenderWeeklySchedule = renderWeeklySchedule;
renderWeeklySchedule = function() {
    _origRenderWeeklySchedule.apply(this, arguments);
    const conflicts = findConflicts();
    // Annotate timeline columns with date for DND
    const grid = document.getElementById('weekly-grid');
    if (!grid) return;
    const isMobile = document.body.classList.contains('mobile-layout');
    const baseDate = isMobile ? currentWeekStart : getMonday(currentWeekStart);
    const numDays = isMobile ? 1 : 7;
    const columns = grid.querySelectorAll('.weekly-column');
    for (let i = 0; i < numDays && i < columns.length; i++) {
        const currentDate = new Date(baseDate);
        currentDate.setDate(currentDate.getDate() + i);
        const dateStr = currentDate.toLocaleDateString('en-CA');
        const timeline = columns[i].querySelector('.weekly-timeline');
        if (timeline) timeline.dataset.date = dateStr;
        // Mark blocks as draggable + conflict + match by approximate position
        const blocks = (timeline && timeline.querySelectorAll('.schedule-block')) || [];
        const daySchedules = state.schedules.filter(s => s.date === dateStr);
        blocks.forEach((block, idx) => {
            const sched = daySchedules[idx];
            if (!sched) return;
            block.dataset.scheduleId = sched.id;
            if (sched.tag !== 'record') {
                block.classList.add('draggable');
                block.setAttribute('draggable', 'true');
                block.addEventListener('dragstart', (e) => {
                    block.classList.add('dragging');
                    e.dataTransfer.setData('text/plain', JSON.stringify({
                        type: 'move-schedule', scheduleId: sched.id
                    }));
                });
                block.addEventListener('dragend', () => block.classList.remove('dragging'));
            }
            if (conflicts.has(sched.id)) block.classList.add('conflict');
        });
    }
    attachScheduleDND();
    renderUnscheduledTasks();
};

// Hook addSchedule form to optionally push to Google Calendar
// (we just push existing schedules created locally if user has GCal authorized)
const _origGcalFetchEvents = fetchGoogleCalendarEvents;
fetchGoogleCalendarEvents = async function(silent) {
    await _origGcalFetchEvents.apply(this, arguments);
    // After fetching, also push any local schedules that lack gcalId (writeback)
    if (!state.settings.gcalAutoWriteback) return; // opt-in
    const toPush = state.schedules.filter(s => !s.gcalId && s.tag !== 'record' && s.tag !== 'カレンダー');
    for (const s of toPush) {
        try { await gcalWriteEvent(s); } catch(e) { /* ignore */ }
    }
    saveData();
};

// ──────────────────────────────────────────────────────────
// Health (Mood / Sleep / Water / Exercise)
// ──────────────────────────────────────────────────────────
let currentHealthDate = '';
function renderHealthView() {
    const today = getTodayString();
    const picker = document.getElementById('health-date-picker');
    if (!currentHealthDate) currentHealthDate = today;
    if (picker && !picker.value) picker.value = currentHealthDate;
    const d = picker ? picker.value : currentHealthDate;
    currentHealthDate = d;
    const data = state.health[d] || {};

    // Mood
    document.querySelectorAll('#mood-selector .mood-btn').forEach(btn => {
        btn.classList.toggle('selected', String(data.mood || '') === btn.dataset.mood);
    });
    const moodNote = document.getElementById('mood-note');
    if (moodNote && document.activeElement !== moodNote) moodNote.value = data.moodNote || '';

    // Sleep
    const sh = document.getElementById('sleep-hours');
    const sq = document.getElementById('sleep-quality');
    if (sh && document.activeElement !== sh) sh.value = data.sleepHours != null ? data.sleepHours : '';
    if (sq) sq.value = data.sleepQuality != null ? data.sleepQuality : '';

    // Water cups
    const cups = data.waterCups || 0;
    const tracker = document.getElementById('water-tracker');
    if (tracker) {
        let html = '';
        for (let i = 1; i <= 8; i++) {
            html += `<div class="water-cup ${i <= cups ? 'filled' : ''}" data-cup="${i}">${i <= cups ? '💧' : '○'}</div>`;
        }
        tracker.innerHTML = html;
        tracker.querySelectorAll('.water-cup').forEach(cup => {
            cup.addEventListener('click', () => {
                const target = parseInt(cup.dataset.cup);
                const current = state.health[d]?.waterCups || 0;
                const newVal = current === target ? target - 1 : target;
                if (!state.health[d]) state.health[d] = {};
                state.health[d].waterCups = newVal;
                saveData();
                renderHealthView();
                renderDailyCheckinBar();
            });
        });
    }

    // Exercise
    const em = document.getElementById('exercise-mins');
    const et = document.getElementById('exercise-type');
    if (em && document.activeElement !== em) em.value = data.exerciseMins != null ? data.exerciseMins : '';
    if (et && document.activeElement !== et) et.value = data.exerciseType || '';

    renderHealthTrends();
}

function saveHealthField(field, value) {
    const d = currentHealthDate || getTodayString();
    if (!state.health[d]) state.health[d] = {};
    state.health[d][field] = value;
    saveData();
    renderDailyCheckinBar();
}

function renderHealthTrends() {
    const container = document.getElementById('health-trends');
    if (!container) return;
    const today = new Date();
    const dates = [];
    for (let i = 6; i >= 0; i--) {
        const dt = new Date(today);
        dt.setDate(dt.getDate() - i);
        dates.push(dt.toLocaleDateString('en-CA'));
    }
    const rows = [
        { key: 'mood', label: '気分', max: 5, color: '#a855f7' },
        { key: 'sleepHours', label: '睡眠 (h)', max: 10, color: '#3b82f6' },
        { key: 'waterCups', label: '水分', max: 8, color: '#06b6d4' },
        { key: 'exerciseMins', label: '運動 (分)', max: 90, color: '#10b981' }
    ];
    container.innerHTML = rows.map(r => {
        const bars = dates.map((d, idx) => {
            const v = (state.health[d] && state.health[d][r.key]) || 0;
            const pct = Math.min(100, (v / r.max) * 100);
            const isToday = idx === dates.length - 1;
            return `<div class="htr-bar ${isToday ? 'today' : ''}" style="height:${Math.max(2, pct)}%; background:${r.color};" title="${d}: ${v}"></div>`;
        }).join('');
        return `<div class="health-trend-row">
            <div class="htr-label">${r.label}</div>
            <div class="htr-bars">${bars}</div>
        </div>`;
    }).join('');
}

// ──────────────────────────────────────────────────────────
// Goals
// ──────────────────────────────────────────────────────────
function renderGoals() {
    const list = document.getElementById('goals-list');
    if (!list) return;
    if (state.goals.length === 0) {
        list.innerHTML = '<p class="empty-state">まだゴールがありません。上のフォームから追加しましょう。</p>';
        return;
    }
    const today = getTodayString();
    list.innerHTML = state.goals.map(g => {
        const pct = g.target > 0 ? Math.min(100, Math.round((g.current / g.target) * 100)) : 0;
        const daysLeft = Math.ceil((new Date(g.deadline) - new Date(today)) / 86400000);
        const deadlineColor = daysLeft < 0 ? 'var(--danger-color)' : daysLeft < 14 ? '#f59e0b' : 'var(--text-secondary)';
        // Determine milestone reached
        let milestoneBadge = '';
        const milestones = [25, 50, 75, 100];
        const reached = milestones.filter(m => pct >= m);
        if (reached.length > 0) {
            milestoneBadge = `<span class="goal-milestone-badge">${reached[reached.length - 1]}% 達成 🎉</span>`;
        }
        return `
            <div class="goal-card">
                <div class="goal-card-header">
                    <div class="goal-title">${g.title}${milestoneBadge}</div>
                    <div class="goal-deadline" style="color:${deadlineColor}">
                        ${daysLeft >= 0 ? `あと ${daysLeft} 日` : `${-daysLeft} 日超過`}
                    </div>
                </div>
                <div class="goal-progress-bar">
                    <div class="goal-progress-fill" style="width:${pct}%"></div>
                </div>
                <div class="goal-stats">
                    <span>${g.current}${g.unit || ''} / ${g.target}${g.unit || ''}</span>
                    <span>${pct}%</span>
                </div>
                <div class="goal-controls">
                    <input type="number" placeholder="進捗を追加" id="goal-add-${g.id}" step="any">
                    <button class="btn primary" onclick="addGoalProgress('${g.id}')">+ 加算</button>
                    <button class="btn secondary" onclick="deleteGoal('${g.id}')">削除</button>
                </div>
                ${g.linkedTag ? `<div style="margin-top:0.5rem; font-size:0.78rem; color:var(--text-secondary);">紐付けタグ: ${g.linkedTag}</div>` : ''}
            </div>
        `;
    }).join('');
}

function addGoalProgress(id) {
    const inp = document.getElementById('goal-add-' + id);
    if (!inp) return;
    const v = parseFloat(inp.value);
    if (!v || isNaN(v)) return;
    const g = state.goals.find(x => x.id === id);
    if (!g) return;
    const prevPct = g.target > 0 ? Math.floor((g.current / g.target) * 100) : 0;
    g.current = (g.current || 0) + v;
    const newPct = g.target > 0 ? Math.floor((g.current / g.target) * 100) : 0;
    // Milestone notification
    const milestones = [25, 50, 75, 100];
    if (!g.milestonesNotified) g.milestonesNotified = [];
    milestones.forEach(m => {
        if (prevPct < m && newPct >= m && !g.milestonesNotified.includes(m)) {
            g.milestonesNotified.push(m);
            fireNotification(`🎉 マイルストーン達成!`, `${g.title} が ${m}% 到達しました！`, 'goal_' + g.id + '_' + m);
            alert(`🎉 ${g.title}: ${m}% 達成！おめでとう！`);
        }
    });
    inp.value = '';
    saveData();
    renderGoals();
}

function deleteGoal(id) {
    if (!confirm('このゴールを削除しますか？')) return;
    state.goals = state.goals.filter(g => g.id !== id);
    saveData();
    renderGoals();
}

// Auto-update goal progress when a record is added (link to tag)
function autoUpdateGoalsFromRecord(taskTag, mins) {
    if (!taskTag || mins <= 0) return;
    state.goals.forEach(g => {
        if (g.linkedTag === taskTag && (g.unit === '時間' || g.unit === 'h')) {
            const prevPct = g.target > 0 ? Math.floor((g.current / g.target) * 100) : 0;
            g.current = (g.current || 0) + mins / 60;
            const newPct = g.target > 0 ? Math.floor((g.current / g.target) * 100) : 0;
            const milestones = [25, 50, 75, 100];
            if (!g.milestonesNotified) g.milestonesNotified = [];
            milestones.forEach(m => {
                if (prevPct < m && newPct >= m && !g.milestonesNotified.includes(m)) {
                    g.milestonesNotified.push(m);
                    fireNotification(`🎉 マイルストーン達成!`, `${g.title} が ${m}% 到達`, 'goal_' + g.id + '_' + m);
                }
            });
        }
    });
}

// ──────────────────────────────────────────────────────────
// Weekly Review + Streak + Monthly Highlights
// ──────────────────────────────────────────────────────────
let reviewOffsetWeeks = 0;  // 0 = current week, -1 = last week, etc.

function getWeekDates(offset = 0) {
    const base = new Date();
    base.setDate(base.getDate() + offset * 7);
    const monday = getMonday(base);
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        dates.push(d.toLocaleDateString('en-CA'));
    }
    return dates;
}

function renderReviewView() {
    const dates = getWeekDates(reviewOffsetWeeks);
    const titleEl = document.getElementById('review-period-title');
    const monday = new Date(dates[0]);
    const sunday = new Date(dates[6]);
    if (titleEl) {
        const label = reviewOffsetWeeks === 0 ? '今週' :
                     reviewOffsetWeeks === -1 ? '先週' : `${-reviewOffsetWeeks}週前`;
        titleEl.textContent = `${label}の振り返り (${monday.getMonth()+1}/${monday.getDate()} 〜 ${sunday.getMonth()+1}/${sunday.getDate()})`;
    }

    const container = document.getElementById('review-content');
    if (!container) return;

    // Aggregate
    let totalTasks = 0, completedTasks = 0, totalMins = 0;
    const dayMins = {}; const tagMins = {};
    dates.forEach(d => {
        const dayTasks = state.tasks.filter(t => t.date === d);
        totalTasks += dayTasks.length;
        completedTasks += dayTasks.filter(t => t.completed).length;
        const records = state.schedules.filter(s => s.date === d && s.tag === 'record');
        let m = 0;
        records.forEach(s => {
            const [sh, sm] = s.startTime.split(':').map(Number);
            const [eh, em] = s.endTime.split(':').map(Number);
            let mins = (eh * 60 + em) - (sh * 60 + sm);
            if (mins < 0) mins += 1440;
            m += mins;
            const tag = s.taskTag || 'タスク';
            tagMins[tag] = (tagMins[tag] || 0) + mins;
        });
        dayMins[d] = m;
        totalMins += m;
    });
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const bestDay = Object.entries(dayMins).sort((a, b) => b[1] - a[1])[0];
    const worstDay = Object.entries(dayMins).filter(([d]) => state.tasks.some(t => t.date === d) || (state.schedules.some(s => s.date === d))).sort((a, b) => a[1] - b[1])[0];
    const topTag = Object.entries(tagMins).sort((a, b) => b[1] - a[1])[0];

    const dayLabel = (dStr) => {
        const dt = new Date(dStr + 'T12:00:00');
        return `${dt.getMonth()+1}/${dt.getDate()}(${['日','月','火','水','木','金','土'][dt.getDay()]})`;
    };

    container.innerHTML = `
        <div class="review-section">
            <div class="review-section-title">主要指標</div>
            <div class="review-stat-grid">
                <div class="review-stat-card">
                    <div class="review-stat-value">${completionRate}%</div>
                    <div class="review-stat-label">タスク完了率<br>(${completedTasks}/${totalTasks})</div>
                </div>
                <div class="review-stat-card">
                    <div class="review-stat-value">${(totalMins/60).toFixed(1)}h</div>
                    <div class="review-stat-label">合計記録時間</div>
                </div>
                <div class="review-stat-card">
                    <div class="review-stat-value">${bestDay && bestDay[1] > 0 ? dayLabel(bestDay[0]) : '-'}</div>
                    <div class="review-stat-label">ベストデー<br>${bestDay && bestDay[1] > 0 ? (bestDay[1]/60).toFixed(1)+'h' : ''}</div>
                </div>
                <div class="review-stat-card">
                    <div class="review-stat-value">${topTag ? topTag[0] : '-'}</div>
                    <div class="review-stat-label">最多投下タグ<br>${topTag ? (topTag[1]/60).toFixed(1)+'h' : ''}</div>
                </div>
            </div>
        </div>
        <div class="review-section">
            <div class="review-section-title">来週のテーマ</div>
            <input type="text" id="next-week-theme" placeholder="例: 毎日2時間以上の勉強時間"
                style="width:100%; padding:10px; border-radius:8px; background:rgba(0,0,0,0.25); border:1px solid var(--panel-border); color:var(--text-primary);"
                value="${(state.weeklyReviews[dates[0]] && state.weeklyReviews[dates[0]].theme) || ''}">
            <button id="btn-save-theme" class="btn primary" style="margin-top:0.5rem;">保存</button>
        </div>
    `;

    document.getElementById('btn-save-theme')?.addEventListener('click', () => {
        const theme = document.getElementById('next-week-theme').value.trim();
        if (!state.weeklyReviews[dates[0]]) state.weeklyReviews[dates[0]] = {};
        state.weeklyReviews[dates[0]].theme = theme;
        state.weeklyReviews[dates[0]].generatedAt = new Date().toISOString();
        saveData();
        alert('保存しました ✓');
    });

    renderStreak();
    renderMonthlyHighlights();
}

function renderStreak() {
    const display = document.getElementById('streak-display');
    if (!display) return;
    // Compute streaks from history + records
    const activeDates = new Set();
    Object.keys(state.history).forEach(d => {
        if (state.history[d].tasksCompleted > 0) activeDates.add(d);
    });
    state.schedules.forEach(s => { if (s.tag === 'record') activeDates.add(s.date); });

    // Current streak: consecutive days ending yesterday or today
    let cur = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const ds = d.toLocaleDateString('en-CA');
        if (activeDates.has(ds)) cur++;
        else if (i === 0) continue; // today might not yet have activity
        else break;
    }
    // Longest streak: scan all
    const sortedDates = Array.from(activeDates).sort();
    let longest = 0, run = 0, prev = null;
    sortedDates.forEach(ds => {
        if (prev) {
            const diff = (new Date(ds) - new Date(prev)) / 86400000;
            run = diff === 1 ? run + 1 : 1;
        } else {
            run = 1;
        }
        if (run > longest) longest = run;
        prev = ds;
    });

    state.streak.currentStreak = cur;
    state.streak.longestStreak = Math.max(longest, state.streak.longestStreak || 0);

    display.innerHTML = `
        <div class="streak-card">
            <div class="streak-value">${cur}</div>
            <div class="streak-label">現在の連続記録 (日)</div>
        </div>
        <div class="streak-card">
            <div class="streak-value">${longest}</div>
            <div class="streak-label">最長記録 (日)</div>
        </div>
        <div class="streak-card">
            <div class="streak-value">${activeDates.size}</div>
            <div class="streak-label">累計アクティブ日数</div>
        </div>
    `;
}

function renderMonthlyHighlights() {
    const container = document.getElementById('monthly-highlights');
    if (!container) return;
    const today = new Date();
    const year = today.getFullYear(), month = today.getMonth();
    const monthStart = new Date(year, month, 1).toLocaleDateString('en-CA');
    const monthEnd = new Date(year, month + 1, 0).toLocaleDateString('en-CA');

    // Best concentration day (longest single record)
    let longestRec = { mins: 0 };
    let totalMonthMins = 0;
    const tagTotals = {};
    state.schedules.forEach(s => {
        if (s.tag !== 'record') return;
        if (s.date < monthStart || s.date > monthEnd) return;
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        let mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins < 0) mins += 1440;
        totalMonthMins += mins;
        if (mins > longestRec.mins) longestRec = { mins, title: s.title, date: s.date };
        const tag = s.taskTag || 'タスク';
        tagTotals[tag] = (tagTotals[tag] || 0) + mins;
    });
    const topTag = Object.entries(tagTotals).sort((a, b) => b[1] - a[1])[0];

    let bestDay = { mins: 0 };
    const dayTotals = {};
    state.schedules.forEach(s => {
        if (s.tag !== 'record') return;
        if (s.date < monthStart || s.date > monthEnd) return;
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        let mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins < 0) mins += 1440;
        dayTotals[s.date] = (dayTotals[s.date] || 0) + mins;
    });
    Object.entries(dayTotals).forEach(([d, m]) => { if (m > bestDay.mins) bestDay = { mins: m, date: d }; });

    let tasksCompleted = 0;
    Object.entries(state.history).forEach(([d, h]) => {
        if (d >= monthStart && d <= monthEnd) tasksCompleted += h.tasksCompleted || 0;
    });

    const items = [];
    if (longestRec.mins > 0) items.push({
        icon: '🎯', title: '最長集中',
        desc: `${longestRec.title} を ${Math.floor(longestRec.mins/60)}時間${longestRec.mins%60}分 (${longestRec.date})`
    });
    if (bestDay.mins > 0) items.push({
        icon: '⭐', title: 'ベストデー',
        desc: `${bestDay.date} に ${(bestDay.mins/60).toFixed(1)}時間 投下`
    });
    if (topTag) items.push({
        icon: '🏷️', title: '最多投下タグ',
        desc: `${topTag[0]} に ${(topTag[1]/60).toFixed(1)}時間`
    });
    if (totalMonthMins > 0) items.push({
        icon: '⏱', title: '今月の合計',
        desc: `${(totalMonthMins/60).toFixed(1)} 時間 (${tasksCompleted} タスク完了)`
    });
    if (items.length === 0) {
        container.innerHTML = '<p class="empty-state">今月のデータはまだありません。</p>';
        return;
    }
    container.innerHTML = items.map(i => `
        <div class="highlight-card">
            <div class="highlight-icon">${i.icon}</div>
            <div class="highlight-text">
                <div class="highlight-title">${i.title}</div>
                <div class="highlight-desc">${i.desc}</div>
            </div>
        </div>
    `).join('');
}

// ──────────────────────────────────────────────────────────
// AI Assist (Anthropic API + Heuristic Fallback)
// ──────────────────────────────────────────────────────────
// ────────── LLM Dispatcher ──────────
// Routes the prompt to the configured provider:
//   - 'claude': Anthropic Claude API (cloud)
//   - 'ollama': local Ollama server (http://localhost:11434/api/chat)
//   - 'openai-compatible': LM Studio / llama.cpp / etc. (POST /v1/chat/completions)
async function callLLM(prompt, system) {
    if (!state.aiSettings || !state.aiSettings.enabled) return null;
    const provider = state.aiSettings.provider || 'claude';
    const sys = system || 'あなたは親身な日本語のアシスタントです。簡潔に答えてください。';
    try {
        if (provider === 'claude') return await callClaudeAPI(prompt, sys);
        if (provider === 'ollama') return await callOllamaAPI(prompt, sys);
        if (provider === 'openai-compatible') return await callOpenAICompatibleAPI(prompt, sys);
    } catch (e) {
        console.warn('LLM call failed:', e);
    }
    return null;
}

async function callClaudeAPI(prompt, system) {
    const key = state.aiSettings.apiKey || '';
    if (!key) return null;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            system: system,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!res.ok) { console.warn('Claude API error:', res.status); return null; }
    const data = await res.json();
    return data.content && data.content[0] && data.content[0].text;
}

async function callOllamaAPI(prompt, system) {
    const baseUrl = (state.aiSettings.localUrl || 'http://localhost:11434').replace(/\/$/, '');
    const model = state.aiSettings.localModel || 'llama3.2';
    const res = await fetch(baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt }
            ],
            stream: false,
            options: { temperature: 0.7, num_predict: 1024 }
        })
    });
    if (!res.ok) { console.warn('Ollama API error:', res.status); return null; }
    const data = await res.json();
    return data.message && data.message.content;
}

async function callOpenAICompatibleAPI(prompt, system) {
    const baseUrl = (state.aiSettings.localUrl || 'http://localhost:1234').replace(/\/$/, '');
    const model = state.aiSettings.localModel || 'local-model';
    const res = await fetch(baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 1024,
            stream: false
        })
    });
    if (!res.ok) { console.warn('OpenAI-compatible API error:', res.status); return null; }
    const data = await res.json();
    return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}

// UI: show/hide provider-specific config blocks based on selected provider
function updateAIProviderUI() {
    const sel = document.getElementById('ai-provider');
    if (!sel) return;
    const claudeBlock = document.getElementById('ai-claude-settings');
    const localBlock = document.getElementById('ai-local-settings');
    const urlInput = document.getElementById('ai-local-url');
    const isClaude = sel.value === 'claude';
    if (claudeBlock) claudeBlock.style.display = isClaude ? 'block' : 'none';
    if (localBlock)  localBlock.style.display  = isClaude ? 'none' : 'block';
    // Set sensible default URL when switching providers and field is empty
    if (urlInput && !urlInput.value) {
        urlInput.placeholder = sel.value === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234';
    }
}

// Connection test — returns { ok: bool, message: string }
async function testLLMConnection() {
    if (!state.aiSettings) return { ok: false, message: '設定がありません' };
    const provider = state.aiSettings.provider;
    try {
        if (provider === 'ollama') {
            const baseUrl = (state.aiSettings.localUrl || 'http://localhost:11434').replace(/\/$/, '');
            const res = await fetch(baseUrl + '/api/tags');
            if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
            const data = await res.json();
            const models = (data.models || []).map(m => m.name).join(', ');
            return { ok: true, message: `接続OK ✓ 利用可能モデル: ${models || '(なし)'}` };
        }
        if (provider === 'openai-compatible') {
            const baseUrl = (state.aiSettings.localUrl || 'http://localhost:1234').replace(/\/$/, '');
            const res = await fetch(baseUrl + '/v1/models');
            if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
            const data = await res.json();
            const models = (data.data || []).map(m => m.id).join(', ');
            return { ok: true, message: `接続OK ✓ 利用可能モデル: ${models || '(なし)'}` };
        }
        return { ok: false, message: 'このプロバイダは接続テスト対象外です' };
    } catch (e) {
        return { ok: false, message: `接続失敗: ${e.message}` };
    }
}

// Heuristic daily plan: place tasks into open time slots
function heuristicDailyPlan() {
    const today = getTodayString();
    const tasks = state.tasks.filter(t => t.date === today && !t.completed);
    if (tasks.length === 0) return [];
    const occupied = state.schedules
        .filter(s => s.date === today && s.tag !== 'record')
        .map(s => {
            const [sh, sm] = s.startTime.split(':').map(Number);
            const [eh, em] = s.endTime.split(':').map(Number);
            return { start: sh * 60 + sm, end: eh * 60 + em };
        })
        .sort((a, b) => a.start - b.start);
    // Find free slots between 9:00 and 22:00
    const dayStart = 9 * 60, dayEnd = 22 * 60;
    const free = [];
    let cursor = dayStart;
    occupied.forEach(o => {
        if (o.start > cursor) free.push({ start: cursor, end: Math.min(o.start, dayEnd) });
        cursor = Math.max(cursor, o.end);
    });
    if (cursor < dayEnd) free.push({ start: cursor, end: dayEnd });

    const plan = [];
    let slotIdx = 0;
    // Sort tasks by duration descending — fit largest first
    const sorted = [...tasks].sort((a, b) => (b.duration || 30) - (a.duration || 30));
    sorted.forEach(t => {
        const need = (t.duration && t.duration > 0) ? t.duration : 30;
        while (slotIdx < free.length) {
            const slot = free[slotIdx];
            const avail = slot.end - slot.start;
            if (avail >= need) {
                const startMins = slot.start;
                const endMins = slot.start + need;
                slot.start = endMins + 10; // 10-min buffer
                if (slot.start >= slot.end) slotIdx++;
                plan.push({ task: t, startMins, endMins });
                return;
            }
            slotIdx++;
        }
    });
    return plan;
}

function formatMinsAsTime(m) {
    const h = Math.floor(m / 60), mm = m % 60;
    return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

async function generateDailyPlan() {
    const output = document.getElementById('ai-plan-output');
    if (!output) return;
    output.style.display = 'block';
    output.innerHTML = '<span class="ai-thinking"></span>計画を生成中...';

    // Try LLM provider first (Claude / Ollama / OpenAI-compatible)
    const llmReady = state.aiSettings.enabled && (
        state.aiSettings.provider === 'claude' ? !!state.aiSettings.apiKey :
        !!state.aiSettings.localUrl
    );
    if (llmReady) {
        const today = getTodayString();
        const tasksStr = state.tasks
            .filter(t => t.date === today && !t.completed)
            .map(t => `- ${t.text} (${t.duration || '?'}分, タグ: ${t.tag})`).join('\n') || 'なし';
        const schedStr = state.schedules
            .filter(s => s.date === today && s.tag !== 'record')
            .map(s => `- ${s.startTime}〜${s.endTime}: ${s.title}`).join('\n') || 'なし';
        const prompt = `今日のタスクと予定です。9:00〜22:00の中で、空き時間にタスクを配置する計画を提案してください。\n\n【予定】\n${schedStr}\n\n【未完了タスク】\n${tasksStr}\n\n出力形式: 各行を "HH:MM〜HH:MM タスク名" のように1行で書いてください。説明文は不要です。`;
        const result = await callLLM(prompt);
        if (result) {
            const lines = result.split('\n').filter(l => l.trim()).slice(0, 12);
            output.innerHTML = lines.map(l => {
                const m = l.match(/^(\d{1,2}:\d{2}[〜～~-]\d{1,2}:\d{2})\s*(.*)$/);
                if (m) return `<div class="ai-plan-item"><span class="ai-plan-time">${m[1]}</span><span>${m[2]}</span></div>`;
                return `<div class="ai-plan-item">${l}</div>`;
            }).join('');
            return;
        }
    }

    // Fallback: heuristic
    const plan = heuristicDailyPlan();
    if (plan.length === 0) {
        output.innerHTML = '<div class="ai-plan-item">未完了タスクがないか、空き時間が確保できませんでした。</div>';
        return;
    }
    const noteText = llmReady
        ? '※ LLM応答が取得できなかったためヒューリスティック生成'
        : '※ AI未設定 (またはOFF) のためヒューリスティック生成';
    output.innerHTML = plan.map(p => `
        <div class="ai-plan-item">
            <span class="ai-plan-time">${formatMinsAsTime(p.startMins)}〜${formatMinsAsTime(p.endMins)}</span>
            <span>${p.task.text}</span>
            <button class="btn secondary" style="padding:2px 8px; font-size:0.75rem; margin-left:auto;"
                onclick="adoptPlanItem('${p.task.id}','${formatMinsAsTime(p.startMins)}','${formatMinsAsTime(p.endMins)}')">採用</button>
        </div>
    `).join('') + `<div style="font-size:0.75rem; color:var(--text-secondary); margin-top:0.5rem;">${noteText}</div>`;
}

function adoptPlanItem(taskId, startStr, endStr) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    state.schedules.push({
        id: generateId(),
        title: task.text,
        date: getTodayString(),
        startTime: startStr,
        endTime: endStr,
        tag: task.tag || 'タスク',
        memo: '',
        linkedTaskId: task.id
    });
    saveData();
    if (document.getElementById('view-schedule').classList.contains('active')) renderWeeklySchedule();
    alert('スケジュールに追加しました ✓');
}

// Task breakdown — propose subtasks
async function aiBreakdownTask() {
    const inputEl = document.getElementById('task-name');
    if (!inputEl || !inputEl.value.trim()) {
        alert('タスク名を入力してから分解ボタンを押してください。');
        return;
    }
    const taskName = inputEl.value.trim();
    let sub = null;
    const llmReady = state.aiSettings.enabled && (
        state.aiSettings.provider === 'claude' ? !!state.aiSettings.apiKey : !!state.aiSettings.localUrl
    );
    if (llmReady) {
        sub = await callLLM(
            `「${taskName}」を3〜5個のサブタスクに分解してください。各行を "- " で始め、簡潔に。説明文は不要。`
        );
    }
    let subtasks = [];
    if (sub) {
        subtasks = sub.split('\n').map(l => l.replace(/^[-・*]\s*/, '').trim()).filter(Boolean).slice(0, 5);
    } else {
        // Heuristic: split by common patterns
        subtasks = [
            `${taskName} - 準備`,
            `${taskName} - 実行`,
            `${taskName} - レビュー`
        ];
    }
    if (subtasks.length === 0) return;
    if (!confirm(`次のサブタスクを今日のタスクに追加しますか？\n\n${subtasks.map(s => '・' + s).join('\n')}`)) return;
    subtasks.forEach(text => addTask(text, 0, false, 'タスク', getTodayString()));
    inputEl.value = '';
    renderDashboard();
}

// Diary mood analysis: keyword-based
function analyzeDiaryMood(text) {
    if (!text) return null;
    const positiveWords = ['楽しい','嬉しい','幸せ','達成','充実','面白い','よかった','成功','スッキリ','満足','穏やか'];
    const negativeWords = ['疲れ','辛い','悲しい','イライラ','不安','失敗','後悔','大変','憂鬱','焦','ストレス'];
    let pos = 0, neg = 0;
    positiveWords.forEach(w => { if (text.includes(w)) pos++; });
    negativeWords.forEach(w => { if (text.includes(w)) neg++; });
    if (pos === 0 && neg === 0) return null;
    if (pos > neg + 1) return { tone: 'positive', score: pos - neg };
    if (neg > pos + 1) return { tone: 'negative', score: neg - pos };
    return { tone: 'neutral', score: 0 };
}

// ──────────────────────────────────────────────────────────
// Smart Templates (Weekday-based)
// ──────────────────────────────────────────────────────────
const WEEKDAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
const WEEKDAY_LABELS = ['日','月','火','水','木','金','土'];

function renderTemplateButtons() {
    const cont = document.getElementById('template-buttons');
    if (!cont) return;
    const today = new Date();
    const todayKey = WEEKDAY_KEYS[today.getDay()];
    cont.innerHTML = WEEKDAY_KEYS.map((k, i) => {
        const count = (state.templates[k] || []).length;
        return `<button class="template-btn ${count === 0 ? 'empty' : ''} ${k === todayKey ? 'today' : ''}" data-day="${k}">
            ${WEEKDAY_LABELS[i]}${count > 0 ? ` (${count})` : ''}
        </button>`;
    }).join('');
    cont.querySelectorAll('.template-btn').forEach(btn => {
        btn.addEventListener('click', () => applyTemplate(btn.dataset.day));
    });
}

function applyTemplate(dayKey) {
    const tpl = state.templates[dayKey] || [];
    if (tpl.length === 0) {
        if (confirm(`${WEEKDAY_LABELS[WEEKDAY_KEYS.indexOf(dayKey)]}曜日のテンプレートはまだ未保存です。今日のタスクを保存しますか？`)) {
            saveCurrentAsTemplate(dayKey);
        }
        return;
    }
    if (!confirm(`${tpl.length}個のタスクを追加しますか？`)) return;
    const today = getTodayString();
    tpl.forEach(t => {
        addTask(t.text, t.duration || 0, false, t.tag || 'タスク', today);
    });
    renderDashboard();
}

function saveCurrentAsTemplate(dayKey) {
    const today = getTodayString();
    const todayTasks = state.tasks
        .filter(t => t.date === today && !t.isRoutine)
        .map(t => ({ text: t.text, duration: t.duration, tag: t.tag }));
    if (todayTasks.length === 0) {
        alert('保存できるタスクが見つかりません。');
        return;
    }
    if (!dayKey) {
        const today = new Date();
        dayKey = WEEKDAY_KEYS[today.getDay()];
    }
    state.templates[dayKey] = todayTasks;
    saveData();
    renderTemplateButtons();
    alert(`${WEEKDAY_LABELS[WEEKDAY_KEYS.indexOf(dayKey)]}曜日のテンプレに ${todayTasks.length}件を保存しました ✓`);
}

function manageTemplates() {
    const list = WEEKDAY_KEYS.map((k, i) => {
        const tpl = state.templates[k] || [];
        return `${WEEKDAY_LABELS[i]}: ${tpl.length}件 ${tpl.map(t => t.text).join(', ')}`;
    }).join('\n');
    const choice = prompt(`テンプレートの状況:\n\n${list}\n\nクリアしたい曜日を入力（日/月/火/水/木/金/土）またはキャンセル:`);
    if (!choice) return;
    const idx = WEEKDAY_LABELS.indexOf(choice.trim());
    if (idx < 0) { alert('無効な入力です'); return; }
    if (confirm(`${choice}曜日のテンプレを削除しますか？`)) {
        state.templates[WEEKDAY_KEYS[idx]] = [];
        saveData();
        renderTemplateButtons();
    }
}

// ──────────────────────────────────────────────────────────
// Voice Input (Web Speech API)
// ──────────────────────────────────────────────────────────
function startVoiceInput(targetInputId) {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) { alert('このブラウザは音声入力をサポートしていません。'); return; }
    const target = document.getElementById(targetInputId);
    const btn = document.getElementById('btn-voice-task');
    if (!target) return;
    const recognition = new Rec();
    recognition.lang = 'ja-JP';
    recognition.continuous = false;
    recognition.interimResults = false;
    if (btn) btn.classList.add('recording');
    recognition.onresult = (e) => {
        const transcript = e.results[0][0].transcript;
        target.value = transcript;
        if (btn) btn.classList.remove('recording');
        target.focus();
    };
    recognition.onerror = () => { if (btn) btn.classList.remove('recording'); };
    recognition.onend = () => { if (btn) btn.classList.remove('recording'); };
    recognition.start();
}

// ──────────────────────────────────────────────────────────
// Patch: timer Finish — also auto-update goals
// ──────────────────────────────────────────────────────────
const _origAddSchedule = addSchedule;

// Patch the timer-finish handler indirectly: intercept saveData after finish
// (Simpler approach: hook into the finish handler via observer pattern.)
// We'll add a wrapper around the finish click handler by re-binding after init.

function rebindTimerFinishForGoals() {
    const btn = document.getElementById('btn-timer-finish');
    if (!btn || btn._goalsPatched) return;
    btn._goalsPatched = true;
    // CAPTURE-phase listener fires BEFORE the original finish handler clears state.
    let pre = null;
    btn.addEventListener('click', (e) => {
        if (!state.timer || !state.timer.taskId) return;
        const task = state.tasks.find(t => t.id === state.timer.taskId);
        let totalSeconds = state.timer.accumulatedSeconds;
        if (state.timer.isRunning && state.timer.startTime) {
            totalSeconds += Math.floor((Date.now() - state.timer.startTime) / 1000);
        }
        pre = {
            tag: task && task.tag,
            text: task && task.text,
            mins: Math.floor(totalSeconds / 60)
        };
    }, true); // capture
    btn.addEventListener('click', () => {
        if (pre && pre.mins >= 1) {
            // Goal auto-update for tag-linked goals
            if (pre.tag) autoUpdateGoalsFromRecord(pre.tag, pre.mins);

            // Exercise auto-recording: tag === '運動' → bump today's exerciseMins
            if (pre.tag === '運動') {
                const today = getTodayString();
                if (!state.health[today]) state.health[today] = {};
                const cur = state.health[today].exerciseMins || 0;
                state.health[today].exerciseMins = cur + pre.mins;
                // Auto-fill exerciseType from task name if empty
                if (!state.health[today].exerciseType && pre.text) {
                    state.health[today].exerciseType = pre.text;
                } else if (state.health[today].exerciseType && pre.text
                           && !state.health[today].exerciseType.includes(pre.text)) {
                    state.health[today].exerciseType += ', ' + pre.text;
                }
            }

            saveData();
            if (document.getElementById('view-goals')?.classList.contains('active')) renderGoals();
        }
        pre = null;
    });
}

// ──────────────────────────────────────────────────────────
// Thermal System (制御工学ダッシュボード)
// ──────────────────────────────────────────────────────────
function renderThermalDashboard() {
    if (!state.thermalSystem) return;
    const ts = state.thermalSystem;
    const today = getTodayString();

    const icText = document.getElementById('thermal-ic-text');
    if (icText) icText.textContent = ts.initialCondition || '—';

    const safeToggle = document.getElementById('thermal-safe-mode-toggle');
    if (safeToggle) safeToggle.checked = ts.safeMode;

    const todayTouch = ts.dailyTouch[today] || {};
    ['morning', 'afternoon', 'night'].forEach(key => {
        const input = document.querySelector('.thermal-block-input[data-block="' + key + '"]');
        const block = document.getElementById('thermal-block-' + key);
        const btn = block ? block.querySelector('.thermal-touch-btn') : null;
        if (input && document.activeElement !== input) {
            input.value = (ts.blocks[key] && ts.blocks[key].content) || '';
        }
        if (block) block.classList.toggle('touched', !!todayTouch[key]);
        if (btn) {
            btn.textContent = todayTouch[key] ? '✓' : 'タッチ';
            btn.classList.toggle('touched', !!todayTouch[key]);
        }
    });

    const blockAfternoon = document.getElementById('thermal-block-afternoon');
    const blockNight = document.getElementById('thermal-block-night');
    if (blockAfternoon) blockAfternoon.style.display = ts.safeMode ? 'none' : '';
    if (blockNight) blockNight.style.display = ts.safeMode ? 'none' : '';

    const safeDesc = document.querySelector('.thermal-safe-desc');
    if (safeDesc) safeDesc.style.display = ts.safeMode ? '' : 'none';

    const todayDist = ts.disturbances[today] || [];
    const todayDistTypes = new Set(todayDist.map(function(d) { return d.type; }));
    document.querySelectorAll('.thermal-dist-chip').forEach(function(chip) {
        chip.classList.toggle('active', todayDistTypes.has(chip.dataset.dist));
    });

    renderThermalGraph();
}

function renderThermalGraph() {
    var container = document.getElementById('thermal-graph-bars');
    var scoreEl = document.getElementById('thermal-week-score');
    if (!container) return;
    var today = new Date();
    var days = [];
    for (var i = 6; i >= 0; i--) {
        var d = new Date(today);
        d.setDate(d.getDate() - i);
        days.push(d.toLocaleDateString('en-CA'));
    }
    var touchedCount = 0;
    var dayLabels = ['日','月','火','水','木','金','土'];
    var todayStr = getTodayString();
    container.innerHTML = days.map(function(dateStr) {
        var touch = state.thermalSystem.dailyTouch[dateStr] || {};
        var anyTouched = touch.morning || touch.afternoon || touch.night;
        if (anyTouched) touchedCount++;
        var dt = new Date(dateStr + 'T12:00:00');
        var label = dayLabels[dt.getDay()];
        var isToday = dateStr === todayStr;
        return '<div class="thermal-bar-col ' + (isToday ? 'today' : '') + '">' +
            '<div class="thermal-bar ' + (anyTouched ? 'active' : '') + '"></div>' +
            '<div class="thermal-bar-label">' + label + '</div>' +
            '</div>';
    }).join('');
    if (scoreEl) scoreEl.textContent = touchedCount + ' / 7';
}

function applyTaskCap() {
    var items = listActive.querySelectorAll('.task-item');
    var cap = 3;
    if (items.length <= cap) return;
    var existing = listActive.querySelector('.task-overflow-toggle');
    if (existing) existing.remove();
    for (var i = cap; i < items.length; i++) {
        items[i].style.display = 'none';
        items[i].classList.add('task-capped');
    }
    var overflow = items.length - cap;
    var more = document.createElement('li');
    more.className = 'task-overflow-toggle';
    more.innerHTML = '<span>他 ' + overflow + '件</span>';
    more.addEventListener('click', function() {
        listActive.querySelectorAll('.task-capped').forEach(function(el) {
            el.style.display = '';
            el.classList.remove('task-capped');
        });
        more.remove();
    });
    listActive.appendChild(more);
}

// ──────────────────────────────────────────────────────────
// renderDashboard patch: include daily check-in bar + thermal
// ──────────────────────────────────────────────────────────
const _origRenderDashboard = renderDashboard;
renderDashboard = function() {
    _origRenderDashboard.apply(this, arguments);
    renderWeeklyGoalBanner();
    renderDailyCheckinBar();
    renderTemplateButtons();
    renderThermalDashboard();
    applyTaskCap();
};

// ──────────────────────────────────────────────────────────
// View switching patch: route new views + safety cleanup
// ──────────────────────────────────────────────────────────
const _origSwitchView = switchView;
switchView = function(viewId) {
    // SAFETY: close any open modals on view switch — otherwise a stuck overlay
    // (timer completion modal, quick-task modal) feels like a frozen screen.
    document.querySelectorAll('.modal-overlay.active, .quick-task-modal.active')
        .forEach(m => m.classList.remove('active'));
    _origSwitchView.apply(this, arguments);
    if (viewId === 'principles') renderPrinciples();
    else if (viewId === 'goals') renderGoals();
    else if (viewId === 'review') renderReviewView();
    else if (viewId === 'timer') {
        // Re-sync UI when re-entering timer view (recover from any stuck state)
        setTimerMode(state.timer.pomodoro.mode || 'normal');
        updateTimerSelect();
        syncTimerUI();
    }
    else if (viewId === 'settings') {
        // populate AI settings fields
        const aiKey = document.getElementById('ai-api-key');
        const aiEnabled = document.getElementById('ai-enabled');
        const aiProvider = document.getElementById('ai-provider');
        const aiLocalUrl = document.getElementById('ai-local-url');
        const aiLocalModel = document.getElementById('ai-local-model');
        if (aiKey) aiKey.value = state.aiSettings.apiKey || '';
        if (aiEnabled) aiEnabled.checked = !!state.aiSettings.enabled;
        if (aiProvider) aiProvider.value = state.aiSettings.provider || 'claude';
        if (aiLocalUrl) aiLocalUrl.value = state.aiSettings.localUrl || '';
        if (aiLocalModel) aiLocalModel.value = state.aiSettings.localModel || '';
        updateAIProviderUI();
        // notification toggles
        const n = state.notifications;
        ['task-before','timer-end','daily-summary','pomodoro'].forEach(k => {
            const el = document.getElementById('notif-' + k);
            if (el) el.checked = n[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] !== false;
        });
        // daily check toggles
        const dc = state.dailyCheckSettings;
        ['calorie','expense'].forEach(k => {
            const el = document.getElementById('dc-' + k);
            if (el) el.checked = !!dc[k];
        });
        updateNotifPermissionStatus();
    }
};

// ──────────────────────────────────────────────────────────
// Setup new event listeners (called after init)
// ──────────────────────────────────────────────────────────
function setupNewEventListeners() {
    // Timer mode tabs
    document.querySelectorAll('.timer-mode-tab').forEach(tab => {
        tab.addEventListener('click', () => setTimerMode(tab.dataset.mode));
    });
    const workIn = document.getElementById('pom-work-mins');
    const breakIn = document.getElementById('pom-break-mins');
    if (workIn) workIn.addEventListener('change', () => {
        const v = parseInt(workIn.value); if (v >= 5 && v <= 120) { state.timer.pomodoro.workMins = v; saveData(); }
    });
    if (breakIn) breakIn.addEventListener('change', () => {
        const v = parseInt(breakIn.value); if (v >= 1 && v <= 60) { state.timer.pomodoro.breakMins = v; saveData(); }
    });

    // AI plan / breakdown
    document.getElementById('btn-ai-plan')?.addEventListener('click', generateDailyPlan);
    document.getElementById('btn-ai-breakdown')?.addEventListener('click', aiBreakdownTask);

    // Voice input
    document.getElementById('btn-voice-task')?.addEventListener('click', () => startVoiceInput('task-name'));

    // Templates
    document.getElementById('btn-save-template')?.addEventListener('click', () => saveCurrentAsTemplate(null));
    document.getElementById('btn-manage-templates')?.addEventListener('click', manageTemplates);

    // Notifications
    document.getElementById('btn-request-notif')?.addEventListener('click', requestNotifPermission);
    ['task-before','timer-end','daily-summary','pomodoro'].forEach(k => {
        const el = document.getElementById('notif-' + k);
        if (!el) return;
        el.addEventListener('change', () => {
            const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            state.notifications[camel] = el.checked;
            saveData();
        });
    });

    // Daily check settings
    ['calorie','expense'].forEach(k => {
        const el = document.getElementById('dc-' + k);
        if (!el) return;
        el.addEventListener('change', () => {
            state.dailyCheckSettings[k] = el.checked;
            saveData();
            renderDailyCheckinBar();
        });
    });

    // AI settings
    document.getElementById('ai-settings-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const prov = document.getElementById('ai-provider').value;
        state.aiSettings.provider = prov;
        state.aiSettings.apiKey = document.getElementById('ai-api-key').value.trim();
        state.aiSettings.localUrl = document.getElementById('ai-local-url').value.trim()
            || (prov === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234');
        state.aiSettings.localModel = document.getElementById('ai-local-model').value.trim() || 'llama3.2';
        state.aiSettings.enabled = document.getElementById('ai-enabled').checked;
        saveData();
        const msg = document.getElementById('ai-save-msg');
        if (msg) { msg.style.opacity = '1'; setTimeout(() => msg.style.opacity = '0', 2500); }
    });

    // Provider switcher — show/hide relevant fields
    document.getElementById('ai-provider')?.addEventListener('change', updateAIProviderUI);

    // Connection test
    document.getElementById('btn-ai-test')?.addEventListener('click', async () => {
        // Save current form values into state first so the test uses them
        const prov = document.getElementById('ai-provider').value;
        state.aiSettings.provider = prov;
        state.aiSettings.localUrl = document.getElementById('ai-local-url').value.trim()
            || (prov === 'ollama' ? 'http://localhost:11434' : 'http://localhost:1234');
        state.aiSettings.localModel = document.getElementById('ai-local-model').value.trim() || 'llama3.2';
        const result = document.getElementById('ai-test-result');
        if (result) {
            result.style.color = 'var(--text-secondary)';
            result.textContent = 'テスト中...';
        }
        const r = await testLLMConnection();
        if (result) {
            result.textContent = r.message;
            result.style.color = r.ok ? 'var(--success-color)' : 'var(--danger-color)';
        }
    });

    // Goals form
    document.getElementById('add-goal-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = document.getElementById('goal-title').value.trim();
        const target = parseFloat(document.getElementById('goal-target').value);
        const unit = document.getElementById('goal-unit').value.trim();
        const deadline = document.getElementById('goal-deadline').value;
        const linkedTag = document.getElementById('goal-tag').value;
        if (!title || !target || !deadline) return;
        state.goals.push({
            id: generateId(), title, target, current: 0, unit, deadline, linkedTag, milestonesNotified: []
        });
        saveData();
        renderGoals();
        e.target.reset();
    });

    // Review prev/next
    document.getElementById('btn-prev-review')?.addEventListener('click', () => {
        reviewOffsetWeeks--; renderReviewView();
    });
    document.getElementById('btn-next-review')?.addEventListener('click', () => {
        if (reviewOffsetWeeks < 0) { reviewOffsetWeeks++; renderReviewView(); }
    });

    // Mobile Quick FAB
    document.getElementById('mobile-quick-fab')?.addEventListener('click', () => {
        document.getElementById('quick-task-modal').classList.add('active');
        setTimeout(() => document.getElementById('quick-task-name').focus(), 50);
    });
    document.getElementById('btn-quick-add-cancel')?.addEventListener('click', () => {
        document.getElementById('quick-task-modal').classList.remove('active');
    });
    document.getElementById('btn-quick-add-submit')?.addEventListener('click', () => {
        const v = document.getElementById('quick-task-name').value.trim();
        if (!v) return;
        // Use smart parser
        if (/\d{1,2}:\d{2}/.test(v)) smartParse(v, 'task');
        else addTask(v, 0, false, 'タスク', getTodayString());
        document.getElementById('quick-task-name').value = '';
        document.getElementById('quick-task-modal').classList.remove('active');
        renderDashboard();
    });
    document.getElementById('quick-task-name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('btn-quick-add-submit').click();
    });

    // Bind goal helpers to window (since called from inline onclick)
    window.addGoalProgress = addGoalProgress;
    window.deleteGoal = deleteGoal;
    window.adoptPlanItem = adoptPlanItem;
    window.switchView = switchView;
    window.resumePausedTimer = resumePausedTimer;
    window.toggleTask = toggleTask;
    window.deleteTask = deleteTask;
    window.toggleMemo = toggleMemo;
    window.deleteMemo = deleteMemo;
    window.deleteCalorieRecord = deleteCalorieRecord;
    window.deleteExpenseRecord = deleteExpenseRecord;

    // Backdrop click closes modals (timer completion + quick task)
    function attachModalDismiss(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });
    }
    attachModalDismiss('timer-completion-modal');
    attachModalDismiss('quick-task-modal');

    // Escape key closes any open modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay.active, .quick-task-modal.active')
                .forEach(m => m.classList.remove('active'));
        }
    });

    // Thermal system
    document.getElementById('thermal-ic-edit')?.addEventListener('click', () => {
        const current = state.thermalSystem.initialCondition || '';
        const text = prompt('明日の最初の一歩を決めてください:', current);
        if (text !== null) {
            state.thermalSystem.initialCondition = text.trim();
            saveData();
            renderThermalDashboard();
        }
    });
    document.getElementById('thermal-safe-mode-toggle')?.addEventListener('change', (e) => {
        state.thermalSystem.safeMode = e.target.checked;
        saveData();
        renderThermalDashboard();
    });
    document.querySelectorAll('.thermal-touch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.block;
            const today = getTodayString();
            if (!state.thermalSystem.dailyTouch[today]) state.thermalSystem.dailyTouch[today] = {};
            state.thermalSystem.dailyTouch[today][key] = !state.thermalSystem.dailyTouch[today][key];
            saveData();
            renderThermalDashboard();
        });
    });
    document.querySelectorAll('.thermal-block-input').forEach(input => {
        input.addEventListener('blur', () => {
            const key = input.dataset.block;
            if (!state.thermalSystem.blocks[key]) state.thermalSystem.blocks[key] = {};
            state.thermalSystem.blocks[key].content = input.value.trim();
            saveData();
        });
    });
    document.querySelectorAll('.thermal-dist-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const type = chip.dataset.dist;
            const today = getTodayString();
            if (!state.thermalSystem.disturbances[today]) state.thermalSystem.disturbances[today] = [];
            const idx = state.thermalSystem.disturbances[today].findIndex(d => d.type === type);
            if (idx >= 0) {
                state.thermalSystem.disturbances[today].splice(idx, 1);
            } else {
                state.thermalSystem.disturbances[today].push({
                    type: type,
                    time: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
                });
            }
            saveData();
            renderThermalDashboard();
        });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.matches('input, textarea, select')) return;
        if ((e.ctrlKey || e.metaKey) || e.altKey) return;
        if (e.key === 'n' || e.key === 'N') { e.preventDefault(); switchView('dashboard'); document.getElementById('task-name')?.focus(); }
        else if (e.key === 't' || e.key === 'T') { switchView('timer'); }
        else if (e.key === 's' || e.key === 'S') { switchView('schedule'); }
        else if (e.key === 'r' || e.key === 'R') { switchView('review'); }
        else if (e.key === 'g' || e.key === 'G') { switchView('goals'); }
    });
}

// Weekly goal banner (dashboard top) — shows the current week's theme set in Review view.
function renderWeeklyGoalBanner() {
    const banner = document.getElementById('weekly-goal-banner');
    if (!banner) return;
    const now = new Date();
    const monday = getMonday(new Date(now));
    const mondayStr = monday.toLocaleDateString('en-CA');
    const review = (state.weeklyReviews && state.weeklyReviews[mondayStr]) || {};
    const theme = (review.theme || '').trim();
    banner.innerHTML = theme
        ? '<div class="wgb-icon">🎯</div>' +
          '<div class="wgb-text">' +
            '<div class="wgb-label">今週の目標</div>' +
            '<div class="wgb-theme">' + theme.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>' +
          '</div>' +
          '<div class="wgb-edit-hint">編集 ↗</div>'
        : '<div class="wgb-icon">🎯</div>' +
          '<div class="wgb-text">' +
            '<div class="wgb-label">今週の目標</div>' +
            '<div class="wgb-theme wgb-empty">クリックして今週のテーマを設定する</div>' +
          '</div>' +
          '<div class="wgb-edit-hint">設定 →</div>';
}

// Principles view (目標・大切な言葉)
function renderPrinciples() {
    if (!state.principles) state.principles = { goals: [], words: [] };
    const renderList = (containerId, items, emptyMsg, kind) => {
        const el = document.getElementById(containerId);
        if (!el) return;
        if (!items || items.length === 0) {
            el.innerHTML = '<div class="empty-state">' + emptyMsg + '</div>';
            return;
        }
        // Newest first
        const sorted = [...items].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        el.innerHTML = sorted.map(item => {
            const date = item.createdAt ? new Date(item.createdAt).toLocaleDateString('ja-JP', { year:'numeric', month:'short', day:'numeric' }) : '';
            const safeText = (item.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return '<div class="principle-item">' +
                   '<div style="flex:1;"><div class="principle-text">' + safeText + '</div>' +
                   (date ? '<div class="principle-meta">' + date + '</div>' : '') + '</div>' +
                   '<button class="principle-del-btn" onclick="deletePrinciple(\'' + kind + '\', \'' + item.id + '\')" title="削除">✕</button>' +
                   '</div>';
        }).join('');
    };
    renderList('principle-goals-list', state.principles.goals, '目標がまだ登録されていません。上の入力欄から追加してください。', 'goals');
    renderList('principle-words-list', state.principles.words, '大切な言葉がまだ登録されていません。上の入力欄から追加してください。', 'words');
}

function addPrinciple(kind, text) {
    text = (text || '').trim();
    if (!text) return;
    if (!state.principles) state.principles = { goals: [], words: [] };
    if (!state.principles[kind]) state.principles[kind] = [];
    state.principles[kind].unshift({ id: generateId(), text, createdAt: new Date().toISOString() });
    saveData();
    renderPrinciples();
}

function deletePrinciple(kind, id) {
    if (!confirm('この項目を削除しますか？')) return;
    if (!state.principles || !state.principles[kind]) return;
    state.principles[kind] = state.principles[kind].filter(x => x.id !== id);
    saveData();
    renderPrinciples();
}

// Expose for inline onclick
window.deletePrinciple = deletePrinciple;

// Principle form event listeners
document.getElementById('add-principle-goal-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('principle-goal-input');
    if (!input || !input.value.trim()) return;
    addPrinciple('goals', input.value);
    input.value = '';
    renderPrinciples();
});
document.getElementById('add-principle-word-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('principle-word-input');
    if (!input || !input.value.trim()) return;
    addPrinciple('words', input.value);
    input.value = '';
    renderPrinciples();
});

ensureNewState();

function bootstrapNewFeatures() {
    ensureNewState();
    setupNewEventListeners();
}

bootstrapNewFeatures();
init();
