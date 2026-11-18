package io.github.kouki8067.dailyflow;

import android.app.ActivityOptions;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * ほかのアプリの通知を Daily Flow の画面に渡すプラグイン。
 *
 * JS: Capacitor.Plugins.Notif
 *   getNotifications() → { enabled, connected, items: [{ key, app, title, text, time }] }
 *   addListener('change', data => ...)   通知が増減したとき
 *   open({ key })                          通知を開く（通知元のアプリへ）
 *   openAccessSettings()                   「通知へのアクセス」の設定画面
 *   openAppInfo()                          アプリ情報（制限付き設定を許可するとき）
 */
@CapacitorPlugin(name = "Notif")
public class NotifPlugin extends Plugin {

    private final Map<String, String> labelCache = new HashMap<>();
    private long lastRebind = 0;

    @Override
    public void load() {
        NotifListener.onChange = () -> notifyListeners("change", buildResult());
    }

    @Override
    protected void handleOnDestroy() {
        NotifListener.onChange = null;
    }

    @PluginMethod
    public void getNotifications(PluginCall call) {
        // 許可されているのに読み取りが止まっている（アプリの更新直後など）ときは、つなぎ直す
        if (accessEnabled() && !NotifListener.isConnected()) {
            long now = System.currentTimeMillis();
            if (now - lastRebind > 30000) {
                lastRebind = now;
                try {
                    NotificationListenerService.requestRebind(new ComponentName(getContext(), NotifListener.class));
                } catch (Exception ignored) { }
            }
        }
        call.resolve(buildResult());
    }

    @PluginMethod
    public void openAccessSettings(PluginCall call) {
        Context ctx = getContext();
        Intent i;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // このアプリの「通知へのアクセス」の画面を直接開く
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
            i.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                new ComponentName(ctx, NotifListener.class).flattenToString());
        } else {
            i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (Exception e) {
            try {
                Intent j = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                j.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(j);
            } catch (Exception e2) {
                call.reject("設定画面を開けませんでした");
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void openAppInfo(PluginCall call) {
        Context ctx = getContext();
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        i.setData(android.net.Uri.parse("package:" + ctx.getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("アプリ情報を開けませんでした");
        }
    }

    /** 通知を開く（通知をタップしたのと同じ動き） */
    @PluginMethod
    public void open(PluginCall call) {
        String key = call.getString("key");
        StatusBarNotification target = null;
        for (StatusBarNotification sbn : NotifListener.current()) {
            if (sbn.getKey().equals(key)) { target = sbn; break; }
        }
        if (target == null) {
            call.reject("この通知はもうありません");
            return;
        }
        Context ctx = getContext();
        Notification n = target.getNotification();
        PendingIntent pi = n.contentIntent;
        try {
            if (pi != null) {
                Bundle opts = null;
                if (Build.VERSION.SDK_INT >= 34) {
                    // Android 14 以降: 前面にいるこのアプリから、通知元のアプリを開くことを許可する
                    ActivityOptions ao = ActivityOptions.makeBasic();
                    ao.setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                    opts = ao.toBundle();
                }
                pi.send(ctx, 0, null, null, null, null, opts);
            } else {
                Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(target.getPackageName());
                if (launch == null) { call.reject("通知元のアプリを開けませんでした"); return; }
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(launch);
            }
            if ((n.flags & Notification.FLAG_AUTO_CANCEL) != 0) NotifListener.cancel(target.getKey());
            call.resolve();
        } catch (Exception e) {
            call.reject("通知元のアプリを開けませんでした");
        }
    }

    private boolean accessEnabled() {
        Set<String> pkgs = NotificationManagerCompat.getEnabledListenerPackages(getContext());
        return pkgs.contains(getContext().getPackageName());
    }

    private JSObject buildResult() {
        JSObject ret = new JSObject();
        ret.put("enabled", accessEnabled());
        ret.put("connected", NotifListener.isConnected());
        JSArray items = new JSArray();
        String self = getContext().getPackageName();
        List<StatusBarNotification> list = NotifListener.current();
        list.sort((a, b) -> Long.compare(b.getPostTime(), a.getPostTime()));

        // まとめ表示用の「グループの親」は、子の通知があるときは出さない
        Set<String> groupsWithChildren = new HashSet<>();
        for (StatusBarNotification sbn : list) {
            Notification n = sbn.getNotification();
            if (n.getGroup() != null && (n.flags & Notification.FLAG_GROUP_SUMMARY) == 0) {
                groupsWithChildren.add(sbn.getPackageName() + "|" + n.getGroup());
            }
        }
        int count = 0;
        for (StatusBarNotification sbn : list) {
            if (count >= 50) break;
            if (self.equals(sbn.getPackageName())) continue;   // 自分の通知（計測中のタイマー）
            if (sbn.isOngoing()) continue;                        // 音楽の再生中など、常に出ている通知
            Notification n = sbn.getNotification();
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0 && n.getGroup() != null
                    && groupsWithChildren.contains(sbn.getPackageName() + "|" + n.getGroup())) continue;
            Bundle ex = n.extras;
            CharSequence title = ex == null ? null : ex.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence text = ex == null ? null : ex.getCharSequence(Notification.EXTRA_BIG_TEXT);
            if (text == null && ex != null) text = ex.getCharSequence(Notification.EXTRA_TEXT);
            if ((title == null || title.length() == 0) && (text == null || text.length() == 0)) continue;
            JSObject o = new JSObject();
            o.put("key", sbn.getKey());
            o.put("app", appLabel(sbn.getPackageName()));
            o.put("title", title == null ? "" : title.toString());
            o.put("text", text == null ? "" : text.toString());
            o.put("time", sbn.getPostTime());
            items.put(o);
            count++;
        }
        ret.put("items", items);
        return ret;
    }

    private String appLabel(String pkg) {
        String cached = labelCache.get(pkg);
        if (cached != null) return cached;
        String label = pkg;
        try {
            PackageManager pm = getContext().getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            label = pm.getApplicationLabel(ai).toString();
        } catch (Exception ignored) { }
        labelCache.put(pkg, label);
        return label;
    }
}
