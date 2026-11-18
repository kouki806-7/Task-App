# vendor/

外部サイト（CDN）から読み込んでいたスクリプトを、このリポジトリに置いたものです。
CDN 側が書き換えられても、アプリに他人のコードが入り込まないようにするためです。

- `firebase-10.11.0/` … npm の `firebase@10.11.0` パッケージ（レジストリの改ざん検査済み）から
  `firebase-app-compat.js`・`firebase-auth-compat.js`・`firebase-firestore-compat.js` をそのまま複製
  （末尾のソースマップ参照だけ削除）。
