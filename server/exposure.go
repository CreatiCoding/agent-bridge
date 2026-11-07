package main

import "path/filepath"

// Exposure (REQ-F-873, IF-259): what a host and its running containers expose (OS, sshd, package versions), as the
// agent read it (agent/exposure.mjs, message {t:'exposure', exposure}). Kept per host in DATA/exposure/<hostId>.json
// so a restart keeps it, and handed back only by the service API. Only the known fields are kept, each cut to size:
// whatever else the agent sent is dropped.

const (
	EXPOSURE_MAX_BYTES  = 4 * 1024 * 1024 // what the server keeps for one host (the agent aims under 2 MB)
	EXPOSURE_PKG_MAX    = 5000
	EXPOSURE_CONT_MAX   = 100
	EXPOSURE_ERRORS_MAX = 50
)

// exposures: hostId -> the cleaned record, or nil when the file was looked for and is not there.
var exposures = map[string]M{}

var exposureEnum = map[string][]string{
	"passwordAuth":    {"yes", "no", "unknown"},
	"permitRootLogin": {"yes", "no", "prohibit-password", "forced-commands-only", "unknown"},
}

func exposureFile(hostID string) string { return filepath.Join(DATA, "exposure", hostID+".json") }

func exStr(v any, n int) string {
	s, _ := v.(string)
	return jsSliceTo(s, n)
}

func exEnum(v any, key string) string {
	s, _ := v.(string)
	if contains(exposureEnum[key], s) {
		return s
	}
	return "unknown"
}

func cleanExOS(v any) any {
	m := asM(v)
	if m == nil || exStr(m["id"], 40) == "" {
		return nil
	}
	return M{"id": exStr(m["id"], 40), "versionId": exStr(m["versionId"], 40), "pretty": exStr(m["pretty"], 120)}
}

func cleanExPackages(v any) M {
	m := asM(v)
	list := []any{}
	for _, x := range asArr(m["list"]) {
		if len(list) >= EXPOSURE_PKG_MAX {
			break
		}
		p := asArr(x)
		if len(p) < 2 {
			continue
		}
		name, ver := exStr(p[0], 200), exStr(p[1], 200)
		if name == "" || ver == "" {
			continue
		}
		list = append(list, []any{name, ver})
	}
	return M{"ecosystem": exStr(m["ecosystem"], 60), "list": list}
}

// cleanExposure: the record as kept, or nil when it is not one.
func cleanExposure(v any) M {
	m := asM(v)
	if m == nil {
		return nil
	}
	at, _ := m["at"].(float64)
	ssh := asM(m["ssh"])
	conts := []any{}
	for _, x := range asArr(m["containers"]) {
		if len(conts) >= EXPOSURE_CONT_MAX {
			break
		}
		c := asM(x)
		if c == nil {
			continue
		}
		conts = append(conts, M{"name": exStr(c["name"], 200), "image": exStr(c["image"], 300), "ports": exStr(c["ports"], 1000), "os": cleanExOS(c["os"]), "sshd": c["sshd"] == true, "packages": cleanExPackages(c["packages"])})
	}
	errs := []any{}
	for _, x := range asArr(m["errors"]) {
		if s := exStr(x, 300); s != "" && len(errs) < EXPOSURE_ERRORS_MAX {
			errs = append(errs, s)
		}
	}
	return M{
		"at": at,
		"os": cleanExOS(m["os"]),
		"ssh": M{"listening": ssh["listening"] == true, "banner": exStr(ssh["banner"], 255),
			"passwordAuth": exEnum(ssh["passwordAuth"], "passwordAuth"), "permitRootLogin": exEnum(ssh["permitRootLogin"], "permitRootLogin")},
		"packages":   cleanExPackages(m["packages"]),
		"containers": conts,
		"errors":     errs,
	}
}

// exposureOf: the host's last record, read from its file the first time it is asked for.
func exposureOf(hostID string) M {
	if e, ok := exposures[hostID]; ok {
		return e
	}
	var e M
	if safeId(hostID) {
		if m, ok := readJSON(exposureFile(hostID), nil).(M); ok {
			e = m
		}
	}
	exposures[hostID] = e
	return e
}

func exposureFromAgent(uid, hostID string, msg M) {
	if !safeId(hostID) || !hosts.Has(hostID) || isDemoHost(hostID) {
		return
	}
	e := cleanExposure(msg["exposure"])
	if e == nil {
		return
	}
	if n := len(jsonBytes(e)); n > EXPOSURE_MAX_BYTES {
		record(uid, hostID, M{"level": "warn", "area": "exposure", "text": "노출 정보가 너무 커서 버림 (" + itoa(n/1024) + " KB)"})
		return
	}
	exposures[hostID] = e
	writeJson(exposureFile(hostID), e)
}

func init() {
	fromAgent["exposure"] = exposureFromAgent
}
