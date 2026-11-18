package io.github.kouki8067.dailyflow;

import android.content.ComponentName;
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

    /** 操作を許可する音楽アプリ */
    static final Set<String> PKGS = new HashSet<>(Arrays.asList(
        "com.spotify.music",   // Spotify
        "com.spotify.lite",    // Spotify Lite
        "com.amazon.mp3"       // Amazon Music
    ));

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
        for (MediaController c : controllers()) {
            PlaybackState s = c.getPlaybackState();
            if (s == null) continue;
            int st = s.getState();
            // 停止・未再生・エラーは出さない（再生中か一時停止中のときだけ）
            if (st == PlaybackState.STATE_NONE || st == PlaybackState.STATE_STOPPED || st == PlaybackState.STATE_ERROR) continue;
            MediaMetadata md = c.getMetadata();
            String title = "", artist = "";
            if (md != null) {
                CharSequence t = md.getText(MediaMetadata.METADATA_KEY_TITLE);
                if (t == null) t = md.getText(MediaMetadata.METADATA_KEY_DISPLAY_TITLE);
                CharSequence a = md.getText(MediaMetadata.METADATA_KEY_ARTIST);
                if (a == null) a = md.getText(MediaMetadata.METADATA_KEY_ALBUM_ARTIST);
                if (a == null) a = md.getText(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE);
                title = t == null ? "" : t.toString();
                artist = a == null ? "" : a.toString();
            }
            long actions = s.getActions();
            JSObject o = new JSObject();
            o.put("pkg", c.getPackageName());
            o.put("app", c.getPackageName().startsWith("com.spotify") ? "Spotify" : "Amazon Music");
            o.put("title", title);
            o.put("artist", artist);
            o.put("playing", isPlaying(s));
            // 操作の可否が申告されていないアプリもあるので、0 のときは使える扱いにする
            o.put("canPrev", actions == 0 || (actions & PlaybackState.ACTION_SKIP_TO_PREVIOUS) != 0);
            o.put("canNext", actions == 0 || (actions & PlaybackState.ACTION_SKIP_TO_NEXT) != 0);
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
        if (target == null) { call.reject("再生中の音楽が見つかりません"); return; }
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
        call.resolve();
    }
}
