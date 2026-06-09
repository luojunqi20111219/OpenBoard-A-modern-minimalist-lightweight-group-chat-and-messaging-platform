import os
import json
import logging
import httpx
from app.config import Config

logger = logging.getLogger("HMSPush")

# Cache the token and its expiration timestamp
_access_token = None
_token_expires_at = 0

async def get_hms_access_token() -> str:
    global _access_token, _token_expires_at
    import time
    now = time.time()
    
    # If token is still valid (with 5 min safety buffer), reuse it
    if _access_token and now < _token_expires_at - 300:
        return _access_token
        
    url = "https://oauth-login.cloud.huawei.com/oauth2/v3/token"
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    data = {
        "grant_type": "client_credentials",
        "client_id": Config.HMS_APP_ID,
        "client_secret": Config.HMS_CLIENT_SECRET
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(url, data=data, headers=headers)
            if response.status_code == 200:
                res_data = response.json()
                _access_token = res_data.get("access_token")
                expires_in = res_data.get("expires_in", 3600)
                _token_expires_at = now + expires_in
                logger.info("Successfully fetched new HMS OAuth access token")
                return _access_token
            else:
                logger.error(f"Failed to get HMS access token: {response.status_code} - {response.text}")
                return ""
    except Exception as e:
        logger.error(f"Error fetching HMS access token: {e}")
        return ""

async def send_hms_push(push_tokens: list, title: str, body: str, room_id: int, receiver: str = None):
    if not push_tokens:
        return
        
    # Clean tokens to avoid empty/null ones
    valid_tokens = [t for t in push_tokens if t and str(t).strip()]
    if not valid_tokens:
        return
        
    access_token = await get_hms_access_token()
    if not access_token:
        logger.error("Skipping HMS push: HMS Access Token is empty")
        return
        
    url = f"https://push-api.cloud.huawei.com/v1/{Config.HMS_APP_ID}/messages:send"
    headers = {
        "Content-Type": "application/json; charset=UTF-8",
        "Authorization": f"Bearer {access_token}"
    }
    
    # Send messages to tokens (max 100 per request according to Huawei API)
    for i in range(0, len(valid_tokens), 100):
        chunk = valid_tokens[i:i+100]
        
        # We send a payload that contains notification (for system popup) and data (for background message processing)
        payload = {
            "validate_only": False,
            "message": {
                "token": chunk,
                "notification": {
                    "title": title,
                    "body": body
                },
                "android": {
                    "notification": {
                        "click_action": {
                            "type": 3  # Open the app launcher homepage
                        },
                        "importance": "NORMAL"
                    }
                },
                "data": json.dumps({
                    "room_id": str(room_id),
                    "receiver": receiver or "",
                    "title": title,
                    "body": body,
                    "action": "logout" if receiver == "logout" else ""
                }, ensure_ascii=False)
            }
        }
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(url, json=payload, headers=headers)
                if response.status_code == 200:
                    res_json = response.json()
                    logger.info(f"HMS Push sent successfully to {len(chunk)} devices. Response: {res_json}")
                else:
                    logger.error(f"HMS Push request failed: {response.status_code} - {response.text}")
        except Exception as e:
            logger.error(f"Error sending HMS push: {e}")
