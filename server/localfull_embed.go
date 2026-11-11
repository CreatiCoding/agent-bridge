//go:build localfull

package main

import "embed"

// The Mac build (-tags localfull, scripts/build-localfull.sh): the web screen and the server's own files, inside the
// one binary the maintainer signs, so a Mac runs nothing that its signature does not cover (REQ-S-103).
//
//go:embed all:fullroot
var fullRootFS embed.FS

func init() { fullRoot = fullRootFS }
