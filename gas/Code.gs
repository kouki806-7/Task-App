/**
 * Daily Flow 連携用 Google Apps Script
 *
 * あなたの Google アカウントの権限で動き、Daily Flow から呼ばれて
 *   - 今日の予定（Googleカレンダー）を返す
 *   - Google ToDo を返す
 *   - タイマーの実績を「Daily Flow 実績」カレンダーに登録する
 * を行います。アプリ側で Google にログインする必要がなくなります。
 *
 * 使い方: このコードは書き換えずにそのまま貼り付けます。
 *   1. 左の「サービス」＋ から「Google Tasks API」を追加（ID: Tasks）
 *   2. 上の関数の選択欄で setup を選んで「実行」→ 権限を許可
 *   3. 下の「実行ログ」に出る合言葉を、Daily Flow の設定に貼り付け
 * 合言葉はこのスクリプトの中（スクリプトプロパティ）に保存されるので、デプロイし直しても変わりません。
 */
const REC_CAL_NAME = 'Daily Flow 実績';
const TZ = 'Asia/Tokyo';

function doGet(e) {
  return handle_((e && e.parameter) || {}, {});
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { /* ignore */ }
  return handle_(Object.assign({}, (e && e.parameter) || {}, body), body);
}

function handle_(p, body) {
  const secret = String(PropertiesService.getScriptProperties().getProperty('secret') || '').trim();
  if (!secret) {
    return json_({ ok: false, error: 'secret_not_set' }); // setup をまだ実行していない
  }
  if (String(p.key || '').trim() !== secret) {
    return json_({ ok: false, error: 'unauthorized' });
  }
  try {
    switch (p.action) {
      case 'ping':
        return json_({ ok: true, email: Session.getEffectiveUser().getEmail() });
      case 'today':
        return json_({
          ok: true,
          email: Session.getEffectiveUser().getEmail(),
          events: safe_(() => getEvents_(p.timeMin, p.timeMax, p.calendars)),
          tasks: safe_(() => getTasks_(p.updatedMin))
        });
      case 'push':
        return json_({ ok: true, push: safe_(() => pushRecords_(body.records || [])) });
      default:
        return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ── 予定 ──────────────────────────────────────────────
function getEvents_(timeMin, timeMax, calendars) {
  const start = new Date(timeMin);
  const end = new Date(timeMax);
  const recCalId = PropertiesService.getScriptProperties().getProperty('recCalId');
  const cals = [CalendarApp.getDefaultCalendar()];
  String(calendars || '').split(',').map(s => s.trim()).filter(Boolean).forEach(id => {
    const c = CalendarApp.getCalendarById(id);
    if (c) cals.push(c);
  });
  const items = [];
  cals.forEach(cal => {
    if (recCalId && cal.getId() === recCalId) return;
    cal.getEvents(start, end).forEach(ev => {
      if (ev.getTag('dfRecordId')) return; // アプリが登録した実績
      const allDay = ev.isAllDayEvent();
      const s = allDay ? ev.getAllDayStartDate() : ev.getStartTime();
      const e = allDay ? ev.getAllDayEndDate() : ev.getEndTime();
      items.push({
        title: ev.getTitle() || '予定',
        allDay: allDay,
        startDate: Utilities.formatDate(s, TZ, 'yyyy-MM-dd'),
        start: allDay ? '' : Utilities.formatDate(s, TZ, 'HH:mm'),
        end: allDay ? '' : Utilities.formatDate(e, TZ, 'HH:mm')
      });
    });
  });
  return items;
}

// ── Google ToDo ───────────────────────────────────────
function getTasks_(updatedMin) {
  if (typeof Tasks === 'undefined') {
    throw new Error('TASKS_SERVICE_MISSING');
  }
  const items = [];
  const lists = Tasks.Tasklists.list({ maxResults: 100 }).items || [];
  lists.forEach(list => {
    let pageToken;
    do {
      const opt = { showCompleted: true, showHidden: true, maxResults: 100 };
      if (updatedMin) opt.updatedMin = updatedMin;
      if (pageToken) opt.pageToken = pageToken;
      const res = Tasks.Tasks.list(list.id, opt);
      (res.items || []).forEach(t => items.push({
        id: t.id, title: t.title || '', status: t.status, due: t.due || null, deleted: !!t.deleted
      }));
      pageToken = res.nextPageToken;
    } while (pageToken);
  });
  return items;
}

// ── 実績の登録 ─────────────────────────────────────────
function recordCalendar_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('recCalId');
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.getOwnedCalendarsByName(REC_CAL_NAME)[0]
      || CalendarApp.createCalendar(REC_CAL_NAME, { timeZone: TZ, summary: 'Daily Flow のタイマーで計測した実績（自動登録）' });
    props.setProperty('recCalId', cal.getId());
  }
  return cal;
}

// records: [{ id, title, start: 'YYYY-MM-DDTHH:mm:00', end: '...', description }]
function pushRecords_(records) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cal = recordCalendar_();
    return records.map(r => {
      const start = new Date(r.start + '+09:00');
      const end = new Date(r.end + '+09:00');
      // 二重登録防止: 同じ記録IDの予定がすでにあれば、それを返す
      const around = cal.getEvents(new Date(start.getTime() - 86400000), new Date(end.getTime() + 86400000));
      const found = around.find(ev => ev.getTag('dfRecordId') === r.id);
      if (found) return { id: r.id, eventId: found.getId() };
      const ev = cal.createEvent(r.title, start, end, { description: r.description || '' });
      ev.setTag('dfRecordId', r.id);
      return { id: r.id, eventId: ev.getId() };
    });
  } finally {
    lock.releaseLock();
  }
}

// ── 共通 ──────────────────────────────────────────────
function safe_(fn) {
  try { return { ok: true, items: fn() }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── 初回設定 ───────────────────────────────────────────
// エディタで setup を選んで「実行」すると、権限の許可と合言葉の作成をまとめて行い、合言葉を実行ログに表示します。
// 何度実行しても合言葉は同じです（作り直したいときは resetSecret を実行）。
function setup() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('secret');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
    props.setProperty('secret', secret);
  }
  Logger.log('アカウント: ' + Session.getEffectiveUser().getEmail());
  Logger.log('カレンダー: ' + CalendarApp.getDefaultCalendar().getName());
  Logger.log(typeof Tasks === 'undefined' ? '⚠ Google Tasks API サービスが未追加です（左の「サービス」＋ から追加）' : 'Google ToDo: OK');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('合言葉: ' + secret);
  Logger.log('↑ この合言葉を Daily Flow の設定に貼り付けてください');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━');
}

function resetSecret() {
  PropertiesService.getScriptProperties().deleteProperty('secret');
  setup();
}
