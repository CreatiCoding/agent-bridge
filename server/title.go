package main

import (
	"path/filepath"
	"strings"
)

// Session names (REQ-F-467). A name a person gave stays. An automatic one (the first words, then Claude Code's
// ai-title) is the session's for good once it has one: rest, end, wake (--resume), an agent restart and a server
// restart leave it as it is (REQ-F-467 rules 2·3, 1.451).

// lockOnly: a name nobody can read (a sealed piece cut too short to keep, REQ-S-099), never put in place of one.
func lockOnly(t string) bool { return t == "🔒" }

// takeAiTitle applies an ai-title line's title to meta. It answers whether the name changed.
//   - A person's name stays (manualTitle).
//   - 🔒 alone (a piece too big to keep) never replaces a name.
//   - The conversation a session was woken into under a new id (a resumed copy, `conv` replay) keeps the name the
//     first conversation gave it: Claude Code names the copy again from its newest words.
func takeAiTitle(meta *Sess, t string) bool {
	if truthy(meta.get("manualTitle")) {
		return false
	}
	cur := meta.str("title")
	if lockOnly(t) && cur != "" {
		return false
	}
	conv := meta.str("conv")
	if conv == "" {
		conv = meta.id()
	}
	if from := meta.str("titleConv"); from != "" && from != conv && cur != "" {
		return false
	}
	meta.set("titleConv", conv)
	if t == cur {
		return false
	}
	meta.set("title", t)
	return true
}

// lockedFolderTitle: a title that is 🔒 alone says nothing, so its folder goes with it (REQ-S-099).
func lockedFolderTitle(title string, cwd string) string {
	if lockOnly(title) && cwd != "" && !hasSeal(cwd) {
		return "🔒 " + filepath.Base(strings.TrimRight(cwd, "/"))
	}
	return title
}
