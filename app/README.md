# Daily Flow Android アプリ

Daily Flow の Web 版（GitHub Pages）を読み込む Android アプリです。Capacitor で作っています。
アプリ版だけの機能：

- **計測中は画面を固定**：▶で計測を始めると、ほかのアプリに切り替えられなくなります。一時停止・完了・破棄で自動で解除されます（設定でオフにできます）
- **通知欄のストップウォッチ**：計測中・一時停止中は通知欄に経過時間が出ます。タップするとアプリに戻ります

画面や機能（`index.html`・`app.js`・`style.css`）を直したときは、アプリを開き直すだけで反映されます。
APK の入れ直しが必要なのは、このフォルダ（`app/`）の中を変えたときだけです。

---

## インストール（スマホだけでできます）

1. スマホのブラウザで https://github.com/kouki806-7/Task-App/releases/latest を開く
2. 「Assets」の **daily-flow.apk** をタップしてダウンロード
3. ダウンロードしたファイルを開く
   - 「この提供元のアプリを許可」と出たら、許可してから戻る（初回のみ）
   - 「Play プロテクト」の確認が出たら「インストールする」（自分で作ったアプリなので問題ありません）
4. ホーム画面の **Daily Flow** を開く

更新するときも同じ手順です（上書きされ、データは残ります）。

### 画面の固定を初めて使うとき

▶を押すと「アプリを固定しますか？」と聞かれるので「OK」を押します。
急いでほかのアプリを使うときは、次の操作で解除できます。

- 3ボタン操作：「戻る」と「履歴（□）」を同時に長押し
- ジェスチャー操作：画面の下から上にスワイプして、そのまま長押し

端末によっては、設定 →「セキュリティ」（または「その他のセキュリティ設定」）→「アプリの固定」をオンにする必要があります。

### 今の版でできないこと

- **端末間同期（Googleログイン）はまだ使えません。** Google がアプリに埋め込んだ画面でのログインを禁止しているためで、次の段階で Android 用のログインに置き換えます。
  それまでは、PC やブラウザ版で「バックアップを保存」したファイルを、アプリの設定の「バックアップから復元」で読み込むとデータを移せます。
- Google カレンダー・ToDo 連携は、設定で中継スクリプトの URL と合言葉を入れれば使えます（ブラウザ版と同じ値）。

---

## 開発メモ

- `capacitor.config.json` の `server.url` で Web 版を読み込む。オフラインで読み込めないときは `www/offline.html`
- 独自プラグイン：`android/app/src/main/java/io/github/kouki8067/dailyflow/FocusPlugin.java`（JS からは `Capacitor.Plugins.Focus.update(...)`）
- ビルド：`.github/workflows/android.yml`（GitHub の Actions 画面の「Run workflow」からも手動で実行できる）。`app/` を変更して main に push すると APK を作り Releases に置く
  - 署名鍵は Secrets の `KEYSTORE_BASE64`（.jks を base64 にしたもの）と `KEYSTORE_PASSWORD`。鍵の別名は `dailyflow`
