package io.github.kouki8067.dailyflow;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 画面の固定・計測中の通知を行う独自プラグインを登録（super.onCreate より前に呼ぶ）
        registerPlugin(FocusPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
