import subprocess
import urllib.request
import json
import ssl
import time
import zipfile
import os
import shutil

def get_github_token():
    try:
        input_data = b'protocol=https\nhost=github.com\n\n'
        p = subprocess.Popen(['git', 'credential', 'fill'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = p.communicate(input_data)
        for line in out.decode('utf-8').split('\n'):
            if line.startswith('password='):
                return line.split('=', 1)[1].strip()
    except Exception as e:
        print("Error getting token from git helper:", e)
    return None

token = get_github_token()
if not token:
    print("Could not find GitHub token. Checking environment...")
    token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')

if not token:
    print("Error: GitHub token is not available.")
    exit(1)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

proxy_handler = urllib.request.ProxyHandler({})
https_handler = urllib.request.HTTPSHandler(context=ctx)
opener = urllib.request.build_opener(proxy_handler, https_handler)

def api_request(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github.v3+json'
    })
    with opener.open(req) as response:
        return json.loads(response.read().decode('utf-8'))

def download_file(url, output_path):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Authorization': f'token {token}'
    })
    with opener.open(req) as response, open(output_path, 'wb') as out_file:
        out_file.write(response.read())

repo = "luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform"

print("Fetching latest workflow runs...")
runs_url = f"https://api.github.com/repos/{repo}/actions/runs?event=push"
runs_data = api_request(runs_url)
runs = runs_data.get('workflow_runs', [])

target_run = None
for r in runs:
    if 'Fix iOS Info.plist' in r['head_commit']['message']:
        target_run = r
        break

if not target_run and runs:
    target_run = runs[0]

if not target_run:
    print("No runs found.")
    exit(1)

run_id = target_run['id']
print(f"Target Run ID: {run_id}")
print(f"Commit: {target_run['head_commit']['message'].strip()}")
print(f"Status: {target_run['status']} | Conclusion: {target_run['conclusion']}")

while True:
    run_info = api_request(f"https://api.github.com/repos/{repo}/actions/runs/{run_id}")
    status = run_info.get('status')
    conclusion = run_info.get('conclusion')
    print(f"Checking status: {status} | Conclusion: {conclusion}")
    if status == 'completed':
        if conclusion != 'success':
            print(f"Build failed with conclusion: {conclusion}")
            exit(1)
        break
    time.sleep(20)

artifacts_url = f"https://api.github.com/repos/{repo}/actions/runs/{run_id}/artifacts"
artifacts_data = api_request(artifacts_url)
artifacts = artifacts_data.get('artifacts', [])

print(f"Found {len(artifacts)} artifacts.")

tmp_dir = "scratch/tmp_download"
os.makedirs(tmp_dir, exist_ok=True)

desktop_dir = r"C:\Users\32709\Desktop"
xinyu_dir = r"C:\Users\32709\Desktop\信语"
os.makedirs(xinyu_dir, exist_ok=True)

for art in artifacts:
    name = art['name']
    art_id = art['id']
    download_url = art['archive_download_url']
    
    zip_path = os.path.join(tmp_dir, f"{name}.zip")
    print(f"Downloading artifact {name} (ID: {art_id})...")
    download_file(download_url, zip_path)
    
    extract_path = os.path.join(tmp_dir, name)
    os.makedirs(extract_path, exist_ok=True)
    with zipfile.ZipFile(zip_path, 'r') as z:
        z.extractall(extract_path)
        
    print(f"Extracted {name}.")
    
    if name == 'OpenBoard-iOS-Unsigned':
        ipa_name = "OpenBoard-iOS-Unsigned.ipa"
        src_ipa = os.path.join(extract_path, ipa_name)
        if os.path.exists(src_ipa):
            shutil.copy2(src_ipa, os.path.join(desktop_dir, ipa_name))
            shutil.copy2(src_ipa, os.path.join(xinyu_dir, ipa_name))
            print(f"Copied {ipa_name} to Desktop and 信语 folder.")
    elif name == 'OpenBoard-iOS-Simulator':
        zip_name = "Runner.app.zip"
        src_zip = os.path.join(extract_path, zip_name)
        if os.path.exists(src_zip):
            shutil.copy2(src_zip, os.path.join(desktop_dir, zip_name))
            shutil.copy2(src_zip, os.path.join(xinyu_dir, zip_name))
            print(f"Copied {zip_name} to Desktop and 信语 folder.")

try:
    shutil.rmtree(tmp_dir)
except Exception as e:
    print("Error cleaning up:", e)

print("Finished download and cleanup!")
