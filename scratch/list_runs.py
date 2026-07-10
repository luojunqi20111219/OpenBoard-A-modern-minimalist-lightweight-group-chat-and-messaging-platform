import urllib.request, json, ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
proxy_handler = urllib.request.ProxyHandler({})
https_handler = urllib.request.HTTPSHandler(context=ctx)
opener = urllib.request.build_opener(proxy_handler, https_handler)

url = 'https://api.github.com/repos/luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform/actions/runs?event=push'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with opener.open(req) as response:
        data = json.loads(response.read().decode('utf-8'))
        for r in data.get('workflow_runs', [])[:10]:
            print(f"ID: {r['id']} | Name: {r['name']} | Commit: {r['head_commit']['message'].strip()} | Status: {r['status']} | Conclusion: {r['conclusion']}")
except Exception as e:
    print("Error:", e)
