package io.github.kouki8067.dailyflow;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * ネイティブ機能（通知の中身・Googleの鍵・画面固定）を使ってよいページかを確かめる。
 *
 * Capacitor はブリッジを「https://kouki806-7.github.io」というオリジン全体に渡すため、
 * 同じ github.io にある別のページ（ほかのリポジトリのページなど）が万一この画面に
 * 読み込まれると、そのページからも呼べてしまう。そこで Daily Flow 本体のパスで
 * 表示しているときだけ応じる。
 */
final class Trusted {
    static final String PREFIX = "https://kouki806-7.github.io/Task-App/";

    private Trusted() { }

    static boolean isTrusted(Plugin p) {
        try {
            final WebView wv = p.getBridge().getWebView();
            if (wv == null) return false;
            final String[] url = new String[1];
            if (Looper.myLooper() == Looper.getMainLooper()) {
                url[0] = wv.getUrl();
            } else {
                final CountDownLatch latch = new CountDownLatch(1);
                new Handler(Looper.getMainLooper()).post(() -> {
                    try { url[0] = wv.getUrl(); } finally { latch.countDown(); }
                });
                if (!latch.await(2, TimeUnit.SECONDS)) return false;
            }
            return url[0] != null && url[0].startsWith(PREFIX);
        } catch (Exception e) {
            return false;
        }
    }

    /** 信頼できないページからの呼び出しなら断って false を返す */
    static boolean check(Plugin p, PluginCall call) {
        if (isTrusted(p)) return true;
        call.reject("このページからは使えません", "UNTRUSTED_ORIGIN");
        return false;
    }
}
