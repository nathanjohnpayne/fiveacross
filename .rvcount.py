import json, subprocess, sys
who, anchor = sys.argv[1], sys.argv[2]
def api(p):
    return json.loads(subprocess.run(["gh","api",p],capture_output=True,text=True).stdout or "[]")
if who == "codex":
    rows = api("repos/nathanjohnpayne/fiveacross/pulls/1207/comments?per_page=100")
    n = sum(1 for c in rows if c["user"]["login"] == "chatgpt-codex-connector[bot]" and c["created_at"] > anchor)
else:
    rows = api("repos/nathanjohnpayne/fiveacross/issues/1207/comments?per_page=100")
    marks = ("Actionable comments posted", "Review skipped", "rate limited", "Action performed")
    n = sum(1 for c in rows if c["user"]["login"] == "coderabbitai[bot]" and c["created_at"] > anchor
            and any(m in (c["body"] or "") for m in marks))
print(n)
