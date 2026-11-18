package io.github.kouki8067.dailyflow;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import android.support.v4.media.session.MediaControllerCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.core.app.NotificationManagerCompat;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.browse.MediaBrowser;
import android.os.Bundle;
import android.os.SystemClock;
import android.service.media.MediaBrowserService;
import android.view.KeyEvent;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 音楽アプリ（Spotify・Amazon Music）の再生を、Daily Flow の画面から操作するプラグイン。
 * 画面の固定中でも、アプリを切り替えずに 再生・一時停止・曲送り・曲戻し ができる。
 * 「通知へのアクセス」の許可（NotifListener）を使って再生中のセッションを読む。
 *
 * JS: Capacitor.Plugins.Media
 *   getMedia() → { enabled, items: [{ pkg, app, title, artist, playing, canPrev, canNext }] }
 *   control({ pkg, action })   action: 'play' | 'pause' | 'toggle' | 'next' | 'prev'
 *   addListener('change', data => ...)
 */
@CapacitorPlugin(name = "Media")
public class MediaPlugin extends Plugin {

    /** 操作を許可する音楽アプリ（表示順） */
    static final List<String> ORDER = Arrays.asList(
        "com.spotify.music",   // Spotify
        "com.spotify.lite",    // Spotify Lite
        "com.amazon.mp3"       // Amazon Music
    );
    static final Set<String> PKGS = new HashSet<>(ORDER);

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaSessionManager msm;
    private boolean registered = false;
    private final List<MediaController> watched = new ArrayList<>();

    /** リピート・シャッフルの状態を読むための互換コントローラ（アプリごと） */
    private final java.util.Map<String, MediaControllerCompat> compat = new java.util.HashMap<>();
    private final MediaControllerCompat.Callback compatCb = new MediaControllerCompat.Callback() {
        @Override public void onRepeatModeChanged(int repeatMode) { changed(); }
        @Override public void onShuffleModeChanged(int shuffleMode) { changed(); }
        @Override public void onSessionReady() { changed(); }
    };

    private synchronized MediaControllerCompat compatFor(MediaController c) {
        String pkg = c.getPackageName();
        MediaControllerCompat cc = compat.get(pkg);
        try {
            if (cc != null && cc.getSessionToken().getToken().equals(c.getSessionToken())) return cc;
        } catch (Exception ignored) { }
        if (cc != null) { try { cc.unregisterCallback(compatCb); } catch (Exception ignored) { } }
        try {
            cc = new MediaControllerCompat(getContext(), MediaSessionCompat.Token.fromToken(c.getSessionToken()));
            cc.registerCallback(compatCb, main);
            compat.put(pkg, cc);
            return cc;
        } catch (Exception e) {
            compat.remove(pkg);
            return null;
        }
    }

    /** アプリ独自の「リピート」「シャッフル」ボタン（Spotify などが Android Auto 向けに出しているもの） */
    private static PlaybackState.CustomAction findCustom(PlaybackState s, String en, String ja) {
        if (s == null || s.getCustomActions() == null) return null;
        for (PlaybackState.CustomAction ca : s.getCustomActions()) {
            String id = String.valueOf(ca.getAction()).toLowerCase(java.util.Locale.ROOT);
            String nm = String.valueOf(ca.getName()).toLowerCase(java.util.Locale.ROOT);
            if (id.contains(en) || nm.contains(en) || nm.contains(ja)) return ca;
        }
        return null;
    }

    private final MediaController.Callback cb = new MediaController.Callback() {
        @Override public void onPlaybackStateChanged(PlaybackState state) { changed(); }
        @Override public void onMetadataChanged(MediaMetadata metadata) { changed(); }
        @Override public void onSessionDestroyed() { changed(); }
    };

    private final MediaSessionManager.OnActiveSessionsChangedListener sessionsListener =
        list -> main.post(() -> { rewatch(list); changed(); });

    private final Runnable fire = () -> {
        // 再生中の曲名などは Daily Flow 本体のページにだけ渡す
        if (Trusted.isTrusted(this)) notifyListeners("change", build());
    };

    @Override
    public void load() {
        msm = (MediaSessionManager) getContext().getSystemService(android.content.Context.MEDIA_SESSION_SERVICE);
        main.post(this::ensureRegistered);
    }

    private volatile long lastResumed = 0;
    private static final int RETURN_NOTIFICATION_ID = 2002;
    private static final String RETURN_CHANNEL = "return";

    @Override
    protected void handleOnResume() {
        lastResumed = SystemClock.elapsedRealtime();
        try { NotificationManagerCompat.from(getContext()).cancel(RETURN_NOTIFICATION_ID); } catch (Exception ignored) { }
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> {
            try { if (registered && msm != null) msm.removeOnActiveSessionsChangedListener(sessionsListener); } catch (Exception ignored) { }
            registered = false;
            rewatch(Collections.emptyList());
        });
    }

    private ComponentName listener() {
        return new ComponentName(getContext(), NotifListener.class);
    }

    /** 再生の変化を知らせてもらう準備（通知へのアクセスが許可されてから有効になる） */
    private void ensureRegistered() {
        if (registered || msm == null) return;
        try {
            msm.addOnActiveSessionsChangedListener(sessionsListener, listener(), main);
            registered = true;
            rewatch(msm.getActiveSessions(listener()));
        } catch (SecurityException e) {
            // まだ許可されていない
        } catch (Exception ignored) { }
    }

    private void rewatch(List<MediaController> list) {
        for (MediaController c : watched) {
            try { c.unregisterCallback(cb); } catch (Exception ignored) { }
        }
        watched.clear();
        if (list == null) return;
        for (MediaController c : list) {
            if (!PKGS.contains(c.getPackageName())) continue;
            try { c.registerCallback(cb, main); watched.add(c); } catch (Exception ignored) { }
            compatFor(c);
        }
    }

    private void changed() {
        // 曲送りなどで続けて届く変化をまとめて1回だけ知らせる
        main.removeCallbacks(fire);
        main.postDelayed(fire, 150);
    }

    /** 対象アプリの再生セッション（1アプリにつき1つ） */
    private List<MediaController> controllers() {
        List<MediaController> out = new ArrayList<>();
        if (msm == null) return out;
        try {
            Set<String> seen = new HashSet<>();
            for (MediaController c : msm.getActiveSessions(listener())) {
                String p = c.getPackageName();
                if (!PKGS.contains(p) || seen.contains(p)) continue;
                seen.add(p);
                out.add(c);
            }
        } catch (SecurityException e) {
            // 通知へのアクセスが未許可
        } catch (Exception ignored) { }
        return out;
    }

    private static boolean isPlaying(PlaybackState s) {
        if (s == null) return false;
        int st = s.getState();
        return st == PlaybackState.STATE_PLAYING || st == PlaybackState.STATE_BUFFERING
            || st == PlaybackState.STATE_CONNECTING || st == PlaybackState.STATE_FAST_FORWARDING
            || st == PlaybackState.STATE_REWINDING || st == PlaybackState.STATE_SKIPPING_TO_NEXT
            || st == PlaybackState.STATE_SKIPPING_TO_PREVIOUS || st == PlaybackState.STATE_SKIPPING_TO_QUEUE_ITEM;
    }

    private JSObject build() {
        JSObject ret = new JSObject();
        boolean enabled = false;
        try {
            if (msm != null) { msm.getActiveSessions(listener()); enabled = true; }
        } catch (Exception ignored) { }
        ret.put("enabled", enabled);
        JSArray items = new JSArray();
        java.util.Map<String, MediaController> byPkg = new java.util.HashMap<>();
        for (MediaController c : controllers()) byPkg.put(c.getPackageName(), c);
        boolean hasSpotify = installed("com.spotify.music");
        for (String pkg : ORDER) {
            // 入っているアプリはいつも表示する（Spotify Lite は通常版がないときだけ）
            if (!installed(pkg)) continue;
            if (pkg.equals("com.spotify.lite") && hasSpotify && !byPkg.containsKey(pkg)) continue;
            MediaController c = byPkg.get(pkg);
            PlaybackState s = c == null ? null : c.getPlaybackState();
            String title = "", artist = "";
            MediaMetadata md = c == null ? null : c.getMetadata();
            if (md != null) {
                CharSequence t = md.getText(MediaMetadata.METADATA_KEY_TITLE);
                if (t == null) t = md.getText(MediaMetadata.METADATA_KEY_DISPLAY_TITLE);
                CharSequence a2 = md.getText(MediaMetadata.METADATA_KEY_ARTIST);
                if (a2 == null) a2 = md.getText(MediaMetadata.METADATA_KEY_ALBUM_ARTIST);
                if (a2 == null) a2 = md.getText(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE);
                title = t == null ? "" : t.toString();
                artist = a2 == null ? "" : a2.toString();
            }
            boolean live = s != null && s.getState() != PlaybackState.STATE_NONE
                && s.getState() != PlaybackState.STATE_STOPPED && s.getState() != PlaybackState.STATE_ERROR;
            long actions = s == null ? 0 : s.getActions();
            JSObject o = new JSObject();
            o.put("pkg", pkg);
            o.put("app", pkg.startsWith("com.spotify") ? "Spotify" : "Amazon Music");
            o.put("title", live ? title : "");
            o.put("artist", live ? artist : "");
            o.put("playing", isPlaying(s));
            o.put("active", live);   // false: 止まっている（▶で再生を始める）
            // 操作の可否が申告されていないアプリもあるので、0 のときは使える扱いにする
            o.put("canPrev", live && (actions == 0 || (actions & PlaybackState.ACTION_SKIP_TO_PREVIOUS) != 0));
            o.put("canNext", live && (actions == 0 || (actions & PlaybackState.ACTION_SKIP_TO_NEXT) != 0));
            // リピート（off / all / one）とシャッフル。状態が分からないときは null
            String repeat = null; Boolean shuffle = null;
            boolean canRepeat = false, canShuffle = false;
            if (live && c != null) {
                MediaControllerCompat cc = compatFor(c);
                int rm = -1, sm = -1;
                if (cc != null) {
                    try { rm = cc.getRepeatMode(); } catch (Exception ignored) { }
                    try { sm = cc.getShuffleMode(); } catch (Exception ignored) { }
                }
                if (rm == PlaybackStateCompat.REPEAT_MODE_NONE) repeat = "off";
                else if (rm == PlaybackStateCompat.REPEAT_MODE_ONE) repeat = "one";
                else if (rm == PlaybackStateCompat.REPEAT_MODE_ALL || rm == PlaybackStateCompat.REPEAT_MODE_GROUP) repeat = "all";
                if (sm == PlaybackStateCompat.SHUFFLE_MODE_NONE) shuffle = false;
                else if (sm == PlaybackStateCompat.SHUFFLE_MODE_ALL || sm == PlaybackStateCompat.SHUFFLE_MODE_GROUP) shuffle = true;
                canRepeat = repeat != null || (actions & PlaybackStateCompat.ACTION_SET_REPEAT_MODE) != 0
                    || findCustom(s, "repeat", "リピート") != null;
                canShuffle = shuffle != null || (actions & PlaybackStateCompat.ACTION_SET_SHUFFLE_MODE) != 0
                    || findCustom(s, "shuffle", "シャッフル") != null;
            }
            o.put("canRepeat", canRepeat);
            o.put("canShuffle", canShuffle);
            if (repeat == null) o.put("repeat", JSObject.NULL); else o.put("repeat", repeat);
            if (shuffle == null) o.put("shuffle", JSObject.NULL); else o.put("shuffle", shuffle);
            items.put(o);
        }
        ret.put("items", items);
        return ret;
    }

    @PluginMethod
    public void getMedia(PluginCall call) {
        if (!Trusted.check(this, call)) return;
        if (!registered) main.post(this::ensureRegistered);
        call.resolve(build());
    }

    @PluginMethod
    public void control(PluginCall call) {
        if (!Trusted.check(this, call)) return;
        String pkg = call.getString("pkg", "");
        String action = call.getString("action", "");
        if (!PKGS.contains(pkg)) { call.reject("このアプリは操作できません"); return; }
        MediaController target = null;
        for (MediaController c : controllers()) {
            if (c.getPackageName().equals(pkg)) { target = c; break; }
        }
        if (target == null || !isLive(target.getPlaybackState())) {
            // 止まっている（起動していない）アプリ: 再生・トグルのときだけ、裏で再生を始めてもらう
            if (action.equals("play") || action.equals("toggle")) {
                if (target != null) {
                    try { target.getTransportControls().play(); call.resolve(result("session")); return; } catch (Exception ignored) { }
                }
                startPlayback(pkg, call);
            } else {
                call.reject("再生中ではありません");
            }
            return;
        }
        MediaController.TransportControls tc = target.getTransportControls();
        try {
            switch (action) {
                case "play": tc.play(); break;
                case "pause": tc.pause(); break;
                case "toggle":
                    if (isPlaying(target.getPlaybackState())) tc.pause(); else tc.play();
                    break;
                case "next": tc.skipToNext(); break;
                case "prev": tc.skipToPrevious(); break;
                case "repeat":
                case "shuffle":
                    if (!toggleMode(target, action)) { call.reject("このアプリでは切り替えられません"); return; }
                    break;
                default: call.reject("不明な操作です"); return;
            }
        } catch (Exception e) {
            call.reject("操作できませんでした");
            return;
        }
        call.resolve(result("session"));
    }

    /**
     * リピート: オフ → 全体 → 1曲 → オフ、シャッフル: オン ⇔ オフ。
     * 状態が読めるアプリは標準の方法で、読めないアプリはアプリ独自のボタンを押した扱いにする。
     */
    private boolean toggleMode(MediaController c, String what) {
        boolean rep = what.equals("repeat");
        MediaControllerCompat cc = compatFor(c);
        int cur = -1;
        if (cc != null) {
            try { cur = rep ? cc.getRepeatMode() : cc.getShuffleMode(); } catch (Exception ignored) { }
        }
        PlaybackState s = c.getPlaybackState();
        long actions = s == null ? 0 : s.getActions();
        boolean std = cc != null && (cur >= 0 || (actions & (rep ? PlaybackStateCompat.ACTION_SET_REPEAT_MODE : PlaybackStateCompat.ACTION_SET_SHUFFLE_MODE)) != 0);
        if (std && cur >= 0) {
            try {
                if (rep) {
                    int next = cur == PlaybackStateCompat.REPEAT_MODE_NONE ? PlaybackStateCompat.REPEAT_MODE_ALL
                        : cur == PlaybackStateCompat.REPEAT_MODE_ONE ? PlaybackStateCompat.REPEAT_MODE_NONE
                        : PlaybackStateCompat.REPEAT_MODE_ONE;
                    cc.getTransportControls().setRepeatMode(next);
                } else {
                    cc.getTransportControls().setShuffleMode(cur == PlaybackStateCompat.SHUFFLE_MODE_NONE
                        ? PlaybackStateCompat.SHUFFLE_MODE_ALL : PlaybackStateCompat.SHUFFLE_MODE_NONE);
                }
                return true;
            } catch (Exception ignored) { }
        }
        PlaybackState.CustomAction ca = rep ? findCustom(s, "repeat", "リピート") : findCustom(s, "shuffle", "シャッフル");
        if (ca != null) {
            try { c.getTransportControls().sendCustomAction(ca, null); return true; } catch (Exception ignored) { }
        }
        if (std) {
            // 状態は読めないが切り替えには対応している: 1段進める扱い
            try {
                if (rep) cc.getTransportControls().setRepeatMode(PlaybackStateCompat.REPEAT_MODE_ALL);
                else cc.getTransportControls().setShuffleMode(PlaybackStateCompat.SHUFFLE_MODE_ALL);
                return true;
            } catch (Exception ignored) { }
        }
        return false;
    }

    private static boolean isLive(PlaybackState s) {
        return s != null && s.getState() != PlaybackState.STATE_NONE
            && s.getState() != PlaybackState.STATE_STOPPED && s.getState() != PlaybackState.STATE_ERROR;
    }

    private static JSObject result(String method) {
        JSObject o = new JSObject();
        o.put("method", method);
        return o;
    }

    private boolean installed(String pkg) {
        try {
            getContext().getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    // ── 止まっているアプリで再生を始める ──
    // 1) アプリの「メディアブラウザ」（Android Auto などが使う窓口）につないで再生を指示
    // 2) 断られたら、イヤホンの再生ボタンと同じ信号をそのアプリに送る
    private void startPlayback(String pkg, PluginCall call) {
        ComponentName svc = findBrowserService(pkg);
        if (svc == null) { sendMediaButton(pkg, call); return; }
        main.post(() -> connectBrowser(pkg, svc, call, false));
    }

    private ComponentName findBrowserService(String pkg) {
        try {
            Intent i = new Intent(MediaBrowserService.SERVICE_INTERFACE).setPackage(pkg);
            List<ResolveInfo> list = getContext().getPackageManager().queryIntentServices(i, 0);
            if (list != null && !list.isEmpty() && list.get(0).serviceInfo != null) {
                return new ComponentName(pkg, list.get(0).serviceInfo.name);
            }
        } catch (Exception ignored) { }
        return null;
    }

    private void connectBrowser(String pkg, ComponentName svc, PluginCall call, boolean recentHint) {
        final boolean[] done = { false };
        final MediaBrowser[] holder = new MediaBrowser[1];
        Bundle hints = null;
        if (recentHint) {
            // 「最近再生したものを続けて」という合図（受け付けるアプリが多い）
            hints = new Bundle();
            hints.putBoolean(MediaBrowserService.BrowserRoot.EXTRA_RECENT, true);
        }
        MediaBrowser.ConnectionCallback cc = new MediaBrowser.ConnectionCallback() {
            @Override public void onConnected() {
                if (done[0]) return;
                done[0] = true;
                try {
                    MediaController c = new MediaController(getContext(), holder[0].getSessionToken());
                    c.getTransportControls().play();
                    call.resolve(result(recentHint ? "browser-recent" : "browser"));
                } catch (Exception e) {
                    sendMediaButton(pkg, call);
                }
                // 再生が始まればアプリが自分で動き続けるので、少し待ってから接続を切る
                main.postDelayed(() -> { try { holder[0].disconnect(); } catch (Exception ignored) { } }, 8000);
            }
            @Override public void onConnectionFailed() { fail(); }
            @Override public void onConnectionSuspended() { fail(); }
            private void fail() {
                if (done[0]) return;
                done[0] = true;
                try { holder[0].disconnect(); } catch (Exception ignored) { }
                if (!recentHint) connectBrowser(pkg, svc, call, true);
                else sendMediaButton(pkg, call);
            }
        };
        try {
            holder[0] = new MediaBrowser(getContext(), svc, cc, hints);
            holder[0].connect();
        } catch (Exception e) {
            done[0] = true;
            sendMediaButton(pkg, call);
            return;
        }
        // 返事がないときは次の方法へ
        main.postDelayed(() -> {
            if (done[0]) return;
            done[0] = true;
            try { holder[0].disconnect(); } catch (Exception ignored) { }
            sendMediaButton(pkg, call);
        }, 6000);
    }

    private void sendMediaButton(String pkg, PluginCall call) {
        try {
            Intent q = new Intent(Intent.ACTION_MEDIA_BUTTON).setPackage(pkg);
            List<ResolveInfo> rs = getContext().getPackageManager().queryBroadcastReceivers(q, 0);
            long t = SystemClock.uptimeMillis();
            KeyEvent[] evs = {
                new KeyEvent(t, t, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY, 0),
                new KeyEvent(t, t, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY, 0)
            };
            boolean sent = false;
            for (KeyEvent ev : evs) {
                Intent i = new Intent(Intent.ACTION_MEDIA_BUTTON).putExtra(Intent.EXTRA_KEY_EVENT, ev);
                if (rs != null && !rs.isEmpty() && rs.get(0).activityInfo != null) {
                    i.setComponent(new ComponentName(pkg, rs.get(0).activityInfo.name));
                } else {
                    i.setPackage(pkg);
                }
                getContext().sendBroadcast(i);
                sent = true;
            }
            if (sent) call.resolve(result("button"));
            else call.reject("再生を始められませんでした");
        } catch (Exception e) {
            call.reject("再生を始められませんでした");
        }
    }

    // ════════════════════════════════════════════════════════
    // 止まっているアプリを再生する（固定を一瞬外す → アプリを開いて再生 → Daily Flow に戻る）
    // Android 12 以降は、裏にいる音楽アプリをほかのアプリから起こせないため、いったん前に出す。
    // ════════════════════════════════════════════════════════

    /** 固定を解除したときに画面がロックされる設定か（true / false / 不明は null） */
    @PluginMethod
    public void getUnpinLock(PluginCall call) {
        if (!Trusted.check(this, call)) return;
        JSObject ret = new JSObject();
        Boolean locks = null;
        try {
            locks = Settings.Secure.getInt(getContext().getContentResolver(), "lock_to_app_exit_locked") != 0;
        } catch (Settings.SettingNotFoundException e) {
            // 未設定のときは「画面ロックを使っていればロックする」のが Android の既定
            KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
            locks = km != null && km.isDeviceSecure();
        } catch (Exception e) {
            locks = null;
        }
        if (locks == null) ret.put("locks", JSObject.NULL); else ret.put("locks", locks);
        ret.put("canReturn", canReturnByItself());
        call.resolve(ret);
    }

    /** 「ほかのアプリの上に重ねて表示」が許可されていれば、確実に自分で戻ってこられる */
    private boolean canReturnByItself() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || Settings.canDrawOverlays(getContext());
    }

    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        if (!Trusted.check(this, call)) return;
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("設定画面を開けませんでした");
        }
    }

    @PluginMethod
    public void launchAndPlay(PluginCall call) {
        if (!Trusted.check(this, call)) return;
        String pkg = call.getString("pkg", "");
        if (!PKGS.contains(pkg)) { call.reject("このアプリは操作できません"); return; }
        Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        if (launch == null) { call.reject("アプリが見つかりません"); return; }
        Activity act = getActivity();
        if (act == null) { call.reject("画面がありません"); return; }
        main.post(() -> {
            // 1) 固定を外す
            try { if (isPinned()) act.stopLockTask(); } catch (Exception ignored) { }
            waitUnpinned(pkg, launch, call, 0);
        });
    }

    private boolean isPinned() {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        return am != null && am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
    }

    private void waitUnpinned(String pkg, Intent launch, PluginCall call, int tries) {
        if (isPinned() && tries < 15) {
            main.postDelayed(() -> waitUnpinned(pkg, launch, call, tries + 1), 100);
            return;
        }
        // 2) 音楽アプリを開く
        try {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(launch);
        } catch (Exception e) {
            call.reject("アプリを開けませんでした");
            return;
        }
        long start = SystemClock.elapsedRealtime();
        main.postDelayed(() -> tryPlay(pkg, call, start, 0, 0), 700);
    }

    // 3) 再生が始まるまで、少しずつ間をあけて再生を指示する（最大 12 秒）
    private void tryPlay(String pkg, PluginCall call, long start, long lastSent, int sent) {
        long now = SystemClock.elapsedRealtime();
        MediaController target = null;
        for (MediaController c : controllers()) {
            if (c.getPackageName().equals(pkg)) { target = c; break; }
        }
        if (target != null && isPlaying(target.getPlaybackState())) {
            main.postDelayed(() -> comeBack(call, true), 600);
            return;
        }
        if (now - start > 12000) { comeBack(call, false); return; }
        if (now - lastSent > 1500) {
            try {
                if (target != null && sent < 3) {
                    target.getTransportControls().play();
                } else if (now - start > 3000) {
                    // 再生の窓口が見つからないときは、再生ボタンの信号を送る（前に出ているアプリに届く）
                    AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
                    long t = SystemClock.uptimeMillis();
                    am.dispatchMediaKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY, 0));
                    am.dispatchMediaKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY, 0));
                }
            } catch (Exception ignored) { }
            final int nextSent = sent + 1;
            final long sentAt = now;
            main.postDelayed(() -> tryPlay(pkg, call, start, sentAt, nextSent), 300);
            return;
        }
        main.postDelayed(() -> tryPlay(pkg, call, start, lastSent, sent), 300);
    }

    // 4) Daily Flow に戻る（戻れなかったときは「タップで戻る」通知を出す）
    private void comeBack(PluginCall call, boolean playing) {
        Activity act = getActivity();
        long asked = SystemClock.elapsedRealtime();
        try {
            Intent back = new Intent(getContext(), MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            getContext().startActivity(back);
        } catch (Exception ignored) { }
        try {
            ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null && act != null) am.moveTaskToFront(act.getTaskId(), 0);
        } catch (Exception ignored) { }
        main.postDelayed(() -> {
            boolean returned = lastResumed >= asked;
            if (!returned) postReturnNotification(playing);
            JSObject r = new JSObject();
            r.put("playing", playing);
            r.put("returned", returned);
            call.resolve(r);
        }, 1500);
    }

    private void postReturnNotification(boolean playing) {
        Context ctx = getContext();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationManager nm = ctx.getSystemService(NotificationManager.class);
                if (nm != null && nm.getNotificationChannel(RETURN_CHANNEL) == null) {
                    NotificationChannel ch = new NotificationChannel(RETURN_CHANNEL, "Daily Flow に戻る", NotificationManager.IMPORTANCE_HIGH);
                    ch.setDescription("音楽アプリを開いたあと、計測中の画面に戻るための通知");
                    nm.createNotificationChannel(ch);
                }
            }
            Intent back = new Intent(ctx, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(ctx, 0, back,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, RETURN_CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_timer)
                .setContentTitle(playing ? "音楽を再生しました" : "Daily Flow に戻る")
                .setContentText("タップすると計測中の画面に戻ります")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setTimeoutAfter(60000)
                .setColor(0xFFF97316)
                .setContentIntent(pi);
            NotificationManagerCompat.from(ctx).notify(RETURN_NOTIFICATION_ID, b.build());
        } catch (SecurityException ignored) {
            // 通知が許可されていない
        }
    }
}
