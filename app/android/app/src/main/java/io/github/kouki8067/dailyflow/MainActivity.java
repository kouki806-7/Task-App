package io.github.kouki8067.dailyflow;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 画面の固定・計測中の通知を行う独自プラグインを登録（super.onCreate より前に呼ぶ）
        registerPlugin(FocusPlugin.class);
        // Google の許可（カレンダー・ToDo・端末間同期のログイン）
        registerPlugin(GoogleAuthPlugin.class);
        // ほかのアプリの通知をアプリ内に表示
        registerPlugin(NotifPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
