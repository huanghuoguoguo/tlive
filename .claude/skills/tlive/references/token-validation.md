# Token Validation Commands

After writing config.env, validate each enabled platform's credentials to catch typos early.

## Telegram

```bash
source ~/.tlive/config.env
curl -s "https://api.telegram.org/bot${TL_TG_BOT_TOKEN}/getMe"
```
Expected: response contains `"ok":true`. If not, the Bot Token is invalid — re-check with @BotFather.

## Feishu / Lark

```bash
source ~/.tlive/config.env
curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"${TL_FS_APP_ID}\",\"app_secret\":\"${TL_FS_APP_SECRET}\"}"
```
Expected: response contains `"code":0`. If not, check App ID and App Secret in the Feishu Developer Console.

## QQ Bot

```bash
source ~/.tlive/config.env
curl -s -X POST "https://api.tencentyun.com/v1/oauth2/token" \
  -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"client_credentials\",\"client_id\":\"${TL_QQ_APP_ID}\",\"client_secret\":\"${TL_QQ_CLIENT_SECRET}\"}"
```
Expected: response contains access token. If not, check App ID and Client Secret in the QQ Open Platform.
