import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

proxy_handler = urllib.request.ProxyHandler({})
https_handler = urllib.request.HTTPSHandler(context=ctx)
opener = urllib.request.build_opener(proxy_handler, https_handler)

url = "https://api.github.com/repos/luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform/actions/runs/28779650164"
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with opener.open(req) as response:
        html = response.read()
        data = json.loads(html.decode('utf-8'))
        print("Status:", data.get('status'))
        print("Conclusion:", data.get('conclusion'))
        print("Display Title:", data.get('display_title'))
        print("Run Attempt:", data.get('run_attempt'))
        print("Updated At:", data.get('updated_at'))
except Exception as e:
    print("Error:", e)
