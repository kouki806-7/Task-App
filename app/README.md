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

### Google との連携（初回のみ）

アプリ版は、Android から直接 Google の許可をもらいます（中継スクリプトは不要）。

**最初に一度だけ、Google 側にこのアプリを登録します**（Daily Flow の端末間同期で使っている Firebase プロジェクトで行います）

1. https://console.firebase.google.com でそのプロジェクトを開き、⚙「プロジェクトの設定」→「全般」→「マイアプリ」→「アプリを追加」→ Android
   - Android パッケージ名：`io.github.kouki8067.dailyflow`
   - デバッグ用の署名証明書 SHA-1：`A1:C8:1F:22:C7:F5:82:0C:B2:FB:EA:61:A6:AC:BD:A3:F6:36:78:92`
   - 「アプリを登録」。`google-services.json` のダウンロードは不要なので、「次へ」で最後まで進める
2. https://console.cloud.google.com で同じプロジェクトを選び、「APIとサービス」→「ライブラリ」で **Google Calendar API** と **Google Tasks API** を「有効にする」
3. 「Google Auth Platform」（または「OAuth 同意画面」）→「対象」で、公開ステータスが「テスト中」なら「アプリを公開」で本番環境にする
   - テスト中のままだと、7日ごとに許可し直しが必要になります
   - 本番環境でも審査は不要です（利用者100人未満の自分用）。許可のときに「このアプリは確認されていません」と出ます

**アプリでの操作**

1. 「今日の予定」の「⟳ Googleと同期」→ アカウントを選ぶ →「このアプリは確認されていません」と出たら「詳細」→「（安全でないページ）に移動」→ カレンダーと ToDo を許可
2. ⚙ 設定 →「端末間のデータ同期」→「Googleでログイン」

どちらも一度だけで、次からはアプリを開いた時点で自動で読み込み・ログインされます。

---

## 開発メモ

- `capacitor.config.json` の `server.url` で Web 版を読み込む。オフラインで読み込めないときは `www/offline.html`
- 独自プラグイン：`android/app/src/main/java/io/github/kouki8067/dailyflow/FocusPlugin.java`（JS からは `Capacitor.Plugins.Focus.update(...)`）
- ビルド：`.github/workflows/android.yml`（GitHub の Actions 画面の「Run workflow」からも手動で実行できる）。`app/` を変更して main に push すると APK を作り Releases に置く
  - Google の許可：`GoogleAuthPlugin.java`（Identity の AuthorizationClient。JS からは `Capacitor.Plugins.GoogleAuth.authorize(...)`）。端末間同期は、そのアクセストークンで Firebase の `signInWithCredential`
  - 署名鍵は Secrets の `KEYSTORE_BASE64`（.jks を base64 にしたもの）と `KEYSTORE_PASSWORD`。鍵の別名は `dailyflow`
