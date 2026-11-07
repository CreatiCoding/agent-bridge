package main

import "testing"

// AC-1647: a picture passed on (a sent message's, kept at send) is served to its sender without asking a Mac, and
// never to another person who names the same id.
func TestImagePassingPerUser(t *testing.T) {
	was := hosts
	defer func() { hosts = was }()
	hosts = newOMap[M]() // no Mac connected: only the kept copy can answer
	id := "0123456789abcdef0123456789abcdef01234567.png"
	passImage("gh-a", id, "image/png", []byte("PNG"))
	t.Cleanup(func() { imgPassing.Delete("gh-a/" + id) })
	got := imageFromMacs("gh-a", id, "")
	if got == nil || string(got.bytes) != "PNG" || got.typ != "image/png" {
		t.Fatalf("sender: got %+v", got)
	}
	if other := imageFromMacs("gh-b", id, ""); other != nil {
		t.Fatalf("another person got the picture: %+v", other)
	}
}
