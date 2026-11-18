package io.github.kouki8067.dailyflow;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * ほかのアプリの通知を読み取るサービス。
 * 画面の固定中は通知欄を開けないので、届いた通知を Daily Flow の中に表示するために使う。
 * 通知の内容は端末の中だけで扱い、保存や送信はしない。
 *
 * 使うには、Android の設定で「通知へのアクセス」を Daily Flow に許可する必要がある。
 */
public class NotifListener extends NotificationListenerService {

    static volatile NotifListener instance;
    /** 通知が増減したときに呼ばれる（NotifPlugin が設定する） */
    static volatile Runnable onChange;

    @Override
    public void onListenerConnected() {
        instance = this;
        fire();
    }

    @Override
    public void onListenerDisconnected() {
        instance = null;
        fire();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        fire();
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        fire();
    }

    private static void fire() {
        Runnable r = onChange;
        if (r != null) {
            try { r.run(); } catch (Exception ignored) { }
        }
    }

    static boolean isConnected() {
        return instance != null;
    }

    static List<StatusBarNotification> current() {
        NotifListener l = instance;
        if (l == null) return new ArrayList<>();
        try {
            StatusBarNotification[] arr = l.getActiveNotifications();
            return arr == null ? new ArrayList<>() : new ArrayList<>(Arrays.asList(arr));
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    static void cancel(String key) {
        NotifListener l = instance;
        if (l == null) return;
        try { l.cancelNotification(key); } catch (Exception ignored) { }
    }
}
