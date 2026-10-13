// Package version reports the pinchpass build version.
package version

import "runtime/debug"

// Number and Revision are injected at build time, for example:
//
//	-ldflags "-X github.com/rubybear-lgtm/pinchpass/version.Number=v1.2.0 \
//	          -X github.com/rubybear-lgtm/pinchpass/version.Revision=abc1234"
//
// They are empty for `go install` and plain `go build`, where the module
// version and VCS metadata that the Go toolchain bakes into the binary are
// used instead.
var (
	Number   string
	Revision string
)

// Resolve returns the version number and short revision, preferring the
// injected values and falling back to the embedded build info.
func Resolve() (number, revision string) {
	number, revision = Number, Revision

	info, ok := debug.ReadBuildInfo()
	if !ok {
		return orDev(number), short(revision)
	}
	if number == "" && info.Main.Version != "" && info.Main.Version != "(devel)" {
		number = info.Main.Version
	}
	if revision == "" {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				revision = setting.Value
				break
			}
		}
	}
	return orDev(number), short(revision)
}

// String returns a single-line, human-readable version string.
func String() string {
	number, revision := Resolve()
	if revision == "" {
		return number
	}
	return number + " (" + revision + ")"
}

func orDev(v string) string {
	if v == "" {
		return "dev"
	}
	return v
}

func short(rev string) string {
	const n = 7
	if len(rev) > n {
		return rev[:n]
	}
	return rev
}
