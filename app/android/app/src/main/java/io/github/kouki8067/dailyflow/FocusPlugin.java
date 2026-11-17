package io.github.kouki8067.dailyflow;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Daily Flow の計測と連動する Android の機能。
 *
 *  - 計測を始めたとき: 画面の固定（startLockTask）を開始
 *  - 一時停止・完了・破棄したとき: 画面の固定を解除（stopLockTask）
 *  - 計測中・一時停止中: 通知欄に経過時間を表示（タップでアプリに戻る）
 *
 * JavaScript からは Capacitor.Plugins.Focus.update({...}) で呼ぶ。
 */
@CapacitorPlugin(
    name = "Focus",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class FocusPlugin extends Plugin {

    private static final String CHANNEL_ID = "timer";
    private static final int NOTIFICATION_ID = 1001;
    private static final int TEST_NOTIFICATION_ID = 1002;
    private boolean askedNotificationPermission = false;

    /**
     * state: "running" | "paused" | "idle"
     * title: 計測中のタスク名
     * startedAt: 経過0秒にあたる時刻（ミリ秒）。running のとき通知のストップウォッチに使う
     * elapsedText: 一時停止中に表示する経過時間（例: "00:12:34"）
     * startLock: true のとき画面の固定を開始する（計測を始めた瞬間だけ true にする）
     */
    @PluginMethod
    public void update(PluginCall call) {
        String state = call.getString("state", "idle");
        // Android 13 以降は通知の許可が必要。初めて計測を始めたときに一度だけ聞く
        if ("running".equals(state)
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED
                && !askedNotificationPermission) {
            askedNotificationPermission = true;
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
            return;
        }
        apply(call);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        apply(call);
    }

    private void apply(PluginCall call) {
        String state = call.getString("state", "idle");
        String title = call.getString("title", "");
        boolean startLock = Boolean.TRUE.equals(call.getBoolean("startLock", false));

        if ("running".equals(state)) {
            // JavaScript の数値は Long/Integer/Double のどれで届くか分からないので、Number として読む
            Object raw = call.getData().opt("startedAt");
            long startedAt = raw instanceof Number ? ((Number) raw).longValue() : System.currentTimeMillis();
            showNotification("⏱ 計測中", title, startedAt, true);
            if (startLock) startPinning();
        } else if ("paused".equals(state)) {
            String elapsed = call.getString("elapsedText", "");
            showNotification("⏸ 一時停止中 " + elapsed, title, 0, false);
            stopPinning();
        } else {
            cancelNotification();
            stopPinning();
        }

        JSObject ret = new JSObject();
        ret.put("pinned", isPinned());
        call.resolve(ret);
    }

    // ── 通知の確認（設定画面から使う） ───────────────────────
    /** 通知が出せる状態かを返す */
    @PluginMethod
    public void checkNotifications(PluginCall call) {
        call.resolve(notificationStatus());
    }

    /** 通知の許可を求める。すでに断られていてダイアログが出ないときは、canAsk=false を返す */
    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "requestNotificationsCallback");
            return;
        }
        call.resolve(notificationStatus());
    }

    @PermissionCallback
    private void requestNotificationsCallback(PluginCall call) {
        call.resolve(notificationStatus());
    }

    /** このアプリの通知設定の画面を開く（一度断った通知を許可し直すとき用） */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Context ctx = getContext();
        Intent i;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName());
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(android.net.Uri.parse("package:" + ctx.getPackageName()));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("通知の設定画面を開けませんでした");
        }
    }

    /** テスト通知を出す */
    @PluginMethod
    public void testNotification(PluginCall call) {
        Context ctx = getContext();
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) {
            call.resolve(notificationStatus());
            return;
        }
        ensureChannel();
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_timer)
            .setContentTitle("Daily Flow")
            .setContentText("通知は正しく届いています")
            .setAutoCancel(true)
            .setColor(0xFFF97316);
        try {
            NotificationManagerCompat.from(ctx).notify(TEST_NOTIFICATION_ID, b.build());
        } catch (SecurityException e) {
            // 通知が許可されていない
        }
        call.resolve(notificationStatus());
    }

    private JSObject notificationStatus() {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        boolean enabled = NotificationManagerCompat.from(ctx).areNotificationsEnabled();
        ret.put("enabled", enabled);
        // 計測中の通知のチャンネルが個別にオフにされていないか
        boolean channelOn = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            NotificationChannel ch = nm == null ? null : nm.getNotificationChannel(CHANNEL_ID);
            if (ch != null) channelOn = ch.getImportance() != NotificationManager.IMPORTANCE_NONE;
        }
        ret.put("channelEnabled", channelOn);
        ret.put("needsRuntimePermission", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU);
        ret.put("sdk", Build.VERSION.SDK_INT);
        ret.put("pinned", isPinned());
        return ret;
    }

    /** 画面が固定されているかを返す（利用者が自分で解除したかを確認できる） */
    @PluginMethod
    public void getState(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("pinned", isPinned());
        ret.put("notificationsAllowed", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        call.resolve(ret);
    }

    // ── 画面の固定 ───────────────────────────────────────
    private void startPinning() {
        final Activity activity = getActivity();
        if (activity == null || isPinned()) return;
        activity.runOnUiThread(() -> {
            try {
                activity.startLockTask();
            } catch (Exception e) {
                // 端末の設定や状態によっては固定できないことがある。計測そのものは続ける
            }
        });
    }

    private void stopPinning() {
        final Activity activity = getActivity();
        if (activity == null || !isPinned()) return;
        activity.runOnUiThread(() -> {
            try {
                activity.stopLockTask();
            } catch (Exception e) {
                // すでに解除されている場合など
            }
        });
    }

    private boolean isPinned() {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return false;
        return am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE;
    }

    // ── 計測中の通知 ─────────────────────────────────────
    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getContext().getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "計測中のタイマー", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("計測中・一時停止中のタスクと経過時間を表示します");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private void showNotification(String heading, String title, long startedAt, boolean running) {
        Context ctx = getContext();
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return;
        ensureChannel();

        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open != null) open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_timer)
            .setContentTitle(title == null || title.isEmpty() ? heading : title)
            .setContentText(heading)
            .setContentIntent(pi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setColor(0xFFF97316);
        if (running) {
            // 通知のストップウォッチ表示（アプリを閉じても進み続ける）
            b.setWhen(startedAt).setShowWhen(true).setUsesChronometer(true);
        } else {
            b.setShowWhen(false);
        }
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, b.build());
        } catch (SecurityException e) {
            // 通知が許可されていない
        }
    }

    private void cancelNotification() {
        NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_ID);
    }
}
