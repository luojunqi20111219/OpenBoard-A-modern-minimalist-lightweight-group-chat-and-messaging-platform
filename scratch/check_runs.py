import json

try:
    with open('scratch/runs.json', encoding='utf-8') as f:
        data = json.load(f)
        runs = data.get('workflow_runs', [])
        for r in runs[:5]:
            msg = r['head_commit']['message'].replace('\n', ' ')
            print(f"Run ID: {r['id']} | Commit: {msg} | Status: {r['status']} | Conclusion: {r['conclusion']}")
except Exception as e:
    print("Error:", e)
