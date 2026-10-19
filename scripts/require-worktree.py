#!/usr/bin/env python3
# Claude Code hook (PreToolUse), see require-worktree.sh. Reads the hook's JSON on stdin; exit 2 blocks.
import json, os, re, subprocess, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cwd = d.get('cwd') or ''
tool = d.get('tool_name') or ''
if not cwd or '/.claude/worktrees/' in cwd:
    sys.exit(0)
try:
    root = subprocess.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], capture_output=True, text=True, timeout=5).stdout.strip()
except Exception:
    sys.exit(0)
# Only this repository's main checkout is guarded (the hook file is in it).
if not root or not os.path.exists(os.path.join(root, 'scripts', 'require-worktree.sh')):
    sys.exit(0)
if tool == 'Bash':
    cmd = str((d.get('tool_input') or {}).get('command') or '')
    # Anything that lands in the checkout: git writes, redirects into files, in-place edits.
    if not re.search(r"(^|[^A-Za-z])git +(commit|push|add|mv|rm|checkout|switch|merge|rebase|reset|apply|stash)( |$)|>>? *[^ /&|]|sed -i|tee |open\([^)]*['\"]w|writeFileSync|rm -rf? ", cmd, re.M):
        sys.exit(0)
sys.stderr.write(
    '이 저장소는 main 체크아웃에서 직접 고치지 않습니다. 먼저 EnterWorktree 로 worktree 를 만들고(.claude/worktrees/ 아래) 거기서 작업하세요.\n'
    f'막은 것: {tool} @ {cwd}\n'
    'worktree 에서 끝낸 뒤: 테스트 → 커밋 → git pull --rebase origin main → git push origin HEAD:main (CLAUDE.md §5).\n'
)
sys.exit(2)
