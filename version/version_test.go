package version

import (
	"strings"
	"testing"
)

func TestResolvePrefersInjectedValues(t *testing.T) {
	restore := set("v1.2.3", "abcdef0123456789")
	defer restore()

	number, revision := Resolve()
	if number != "v1.2.3" {
		t.Errorf("number = %q, want v1.2.3", number)
	}
	if revision != "abcdef0" {
		t.Errorf("revision = %q, want abcdef0 (short)", revision)
	}
}

func TestStringWithInjectedValues(t *testing.T) {
	restore := set("v1.2.3", "abc1234")
	defer restore()

	if got := String(); got != "v1.2.3 (abc1234)" {
		t.Errorf("String() = %q, want %q", got, "v1.2.3 (abc1234)")
	}
}

func TestStringWithoutRevision(t *testing.T) {
	restore := set("v1.2.3", "")
	defer restore()

	// A plain `go build` still bakes in a VCS revision, so the injected empty
	// revision may be filled from build info; the number must always win.
	if got := String(); !strings.HasPrefix(got, "v1.2.3") {
		t.Errorf("String() = %q, want prefix v1.2.3", got)
	}
}

func TestResolveFallsBackToDev(t *testing.T) {
	restore := set("", "")
	defer restore()

	number, _ := Resolve()
	if number == "" {
		t.Fatal("number must never be empty")
	}
	if !strings.HasPrefix(number, "dev") && !strings.HasPrefix(number, "v") {
		t.Errorf("number = %q, want a dev or module version", number)
	}
}

func set(number, revision string) func() {
	prevNumber, prevRevision := Number, Revision
	Number, Revision = number, revision
	return func() {
		Number, Revision = prevNumber, prevRevision
	}
}
