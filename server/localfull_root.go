package main

import "io/fs"

// fullRoot: the files a Mac build carries (localfull_embed.go). nil in every other build, where `local` runs only
// with --root (the tests).
var fullRoot fs.FS
