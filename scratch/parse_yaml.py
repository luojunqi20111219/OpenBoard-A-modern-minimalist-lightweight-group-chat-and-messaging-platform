import sys

try:
    with open('.github/workflows/build_ios.yml', 'r', encoding='utf-8') as f:
        lines = f.readlines()
        for idx, line in enumerate(lines):
            # Check for tabs
            if '\t' in line:
                print(f"Line {idx+1} has tab character!")
            # Check indentation spaces
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            print(f"Line {idx+1:03d} (Indent {indent:02d}): {line.strip()[:50]}")
except Exception as e:
    print("Error:", e)
