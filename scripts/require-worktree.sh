#!/bin/bash
# Claude Code hook (PreToolUse): work on this repository happens in a git worktree, never in the main checkout.
# Blocks file edits, commits and pushes made from the main checkout; a worktree under .claude/worktrees/ passes.
# The hook's JSON arrives on stdin and goes to the Python beside this file (a heredoc here would eat that stdin).
exec python3 "$(dirname "$0")/require-worktree.py"
