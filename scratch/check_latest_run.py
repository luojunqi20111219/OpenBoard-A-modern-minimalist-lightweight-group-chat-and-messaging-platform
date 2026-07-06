import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

proxy_handler = urllib.request.ProxyHandler({})
https_handler = urllib.request.HTTPSHandler(context=ctx)
opener = urllib.request.build_opener(proxy_handler, https_handler)

url = "https://api.github.com/repos/luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform/actions/runs"
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with opener.open(req) as response:
        html = response.read()
        data = json.loads(html)
        runs = data.get('workflow_runs', [])
        for r in runs[:5]:
            msg = r['head_commit']['message'].replace('\n', ' ')
            print(f"Run ID: {r['id']} | Commit: {msg} | Status: {r['status']} | Conclusion: {r['conclusion']}")
except Exception as e:
    print("Error:", e)
