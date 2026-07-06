import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

proxy_handler = urllib.request.ProxyHandler({})
https_handler = urllib.request.HTTPSHandler(context=ctx)
opener = urllib.request.build_opener(proxy_handler, https_handler)

url = "https://api.github.com/repos/luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform/commits/18f6e10/check-runs"
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with opener.open(req) as response:
        html = response.read()
        data = json.loads(html.decode('utf-8'))
        check_runs = data.get('check_runs', [])
        print("Total check runs:", data.get('total_count'))
        for cr in check_runs:
            print(f"Check Run: {cr['name']} | Status: {cr['status']} | Conclusion: {cr['conclusion']}")
            print("Output Title:", cr.get('output', {}).get('title'))
            print("Output Summary:", cr.get('output', {}).get('summary'))
            print("Output Text:", cr.get('output', {}).get('text'))
except Exception as e:
    print("Error:", e)
