import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

proxy_handler = urllib.request.ProxyHandler({})
https_handler = urllib.request.HTTPSHandler(context=ctx)
opener = urllib.request.build_opener(proxy_handler, https_handler)

url = "https://api.github.com/repos/luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform/actions/runs/28779650164/jobs"
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with opener.open(req) as response:
        html = response.read()
        print("Length of response:", len(html))
        data = json.loads(html.decode('utf-8'))
        print("Keys:", data.keys())
        jobs = data.get('jobs', [])
        print("Jobs length:", len(jobs))
        for j in jobs:
            print(f"Job: {j['name']} ({j['conclusion']})")
            for step in j.get('steps', []):
                print(f"  Step: {step['name']} -> {step['conclusion']}")
except Exception as e:
    import traceback
    traceback.print_exc()
