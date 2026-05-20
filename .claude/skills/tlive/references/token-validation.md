# Feishu Credential Validation

After writing `~/.tlive/config.env`, validate the Feishu app credentials before
starting a long troubleshooting session.

```bash
set -a
source ~/.tlive/config.env
set +a

curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"${TL_FS_APP_ID}\",\"app_secret\":\"${TL_FS_APP_SECRET}\"}"
```

Expected result: JSON contains `"code":0` and a `tenant_access_token`.

If validation fails:
- Re-check `TL_FS_APP_ID` and `TL_FS_APP_SECRET`.
- Make sure the app belongs to the tenant the user is testing in.
- For Lark tenants, use the Lark developer console when copying credentials.

Validation only proves the credentials are valid. Message receive and card
actions also require long connection events, permissions, app publishing, and
admin approval.
