package io.github.kouki8067.dailyflow;

import android.app.Activity;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import java.util.ArrayList;
import java.util.List;

/**
 * Google の許可を Android から直接もらうプラグイン。
 *
 * アプリに埋め込んだ画面では Google のログインが使えないため、Android の仕組み（Identity の AuthorizationClient）で
 * アクセストークンをもらい、JavaScript に渡す。一度許可すれば、次からは画面を出さずに（silent に）もらえる。
 *
 * JS: Capacitor.Plugins.GoogleAuth.authorize({ scopes: [...], interactive: true|false })
 *   → { accessToken, grantedScopes: [...] }
 *   interactive=false で許可がまだのときは、エラーコード NEEDS_CONSENT を返す
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {

    private ActivityResultLauncher<IntentSenderRequest> consentLauncher;
    private PluginCall pendingCall;

    @Override
    public void load() {
        // 許可画面の結果を受け取る（Activity の開始前に登録する必要がある）
        consentLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            result -> {
                PluginCall call = pendingCall;
                pendingCall = null;
                if (call == null) return;
                // 結果の中に Google からのエラー理由が入っていることがあるので、まず読み取る
                if (result.getData() != null) {
                    try {
                        AuthorizationResult r = Identity.getAuthorizationClient(getContext())
                            .getAuthorizationResultFromIntent(result.getData());
                        if (r.getAccessToken() != null) {
                            resolveToken(call, r);
                            return;
                        }
                    } catch (ApiException e) {
                        rejectWithStatus(call, e.getStatusCode(), e.getMessage());
                        return;
                    } catch (Exception e) {
                        // 読み取れなければ下へ
                    }
                }
                call.reject("許可がキャンセルされました（結果コード " + result.getResultCode()
                    + (result.getData() == null ? "、詳細なし" : "") + "）", "CANCELED");
            });
    }

    @PluginMethod
    public void authorize(final PluginCall call) {
        if (!Trusted.check(this, call)) return;
        JSArray arr = call.getArray("scopes");
        final boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        List<Scope> scopes = new ArrayList<>();
        try {
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) scopes.add(new Scope(arr.getString(i)));
            }
        } catch (Exception e) {
            call.reject("scopes が正しくありません", "BAD_ARGS");
            return;
        }
        if (scopes.isEmpty()) {
            call.reject("scopes が空です", "BAD_ARGS");
            return;
        }

        AuthorizationRequest req = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
        Identity.getAuthorizationClient(getActivity())
            .authorize(req)
            .addOnSuccessListener(r -> {
                if (r.hasResolution()) {
                    // まだ許可していない（または許可が取り消された）
                    if (!interactive || r.getPendingIntent() == null) {
                        call.reject("Google の許可が必要です", "NEEDS_CONSENT");
                        return;
                    }
                    pendingCall = call;
                    try {
                        consentLauncher.launch(new IntentSenderRequest.Builder(r.getPendingIntent().getIntentSender()).build());
                    } catch (Exception e) {
                        pendingCall = null;
                        call.reject("許可の画面を開けませんでした", "FAILED");
                    }
                } else {
                    resolveToken(call, r);
                }
            })
            .addOnFailureListener(e -> {
                if (e instanceof ApiException) {
                    rejectWithStatus(call, ((ApiException) e).getStatusCode(), e.getMessage());
                } else {
                    call.reject(e.getMessage() == null ? "Google の許可を受け取れませんでした" : e.getMessage(), "FAILED");
                }
            });
    }

    /** Google のステータスコードを、原因が分かる言葉にして返す */
    private void rejectWithStatus(PluginCall call, int status, String raw) {
        String code = "FAILED";
        String msg;
        switch (status) {
            case 10:
                code = "DEVELOPER_ERROR";
                msg = "Google Cloud にこのアプリ（パッケージ名と SHA-1）が登録されていないか、登録内容が違います";
                break;
            case 12501:
            case 16:
                code = "CANCELED";
                msg = "許可の画面が閉じられました";
                break;
            case 7:
                msg = "通信できませんでした";
                break;
            case 8:
                msg = "Google 側で一時的なエラーが起きました。少し待って再度お試しください";
                break;
            default:
                msg = "Google の許可を受け取れませんでした";
        }
        call.reject(msg + "（コード " + status + (raw == null ? "" : "：" + raw) + "）", code);
    }

    private void resolveToken(PluginCall call, AuthorizationResult r) {
        if (r.getAccessToken() == null) {
            call.reject("アクセストークンを受け取れませんでした", "FAILED");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("accessToken", r.getAccessToken());
        JSArray granted = new JSArray();
        if (r.getGrantedScopes() != null) {
            for (String s : r.getGrantedScopes()) granted.put(s);
        }
        ret.put("grantedScopes", granted);
        call.resolve(ret);
    }
}
