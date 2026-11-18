package io.github.kouki8067.dailyflow;

import android.content.ComponentName;
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
                default: call.reject("不明な操作です"); return;
            }
        } catch (Exception e) {
            call.reject("操作できませんでした");
            return;
        }
        call.resolve(result("session"));
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
}
