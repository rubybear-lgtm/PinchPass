package main

import (
	crand "crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rubybear-lgtm/pinchpass/server"
	"github.com/rubybear-lgtm/pinchpass/store"
	"github.com/rubybear-lgtm/pinchpass/token"
	"github.com/rubybear-lgtm/pinchpass/tunnel"
	"golang.org/x/crypto/nacl/secretbox"
)

func encryptBlob(t *testing.T, keyB64, plaintext string) string {
	t.Helper()
	key, _ := base64.RawURLEncoding.DecodeString(keyB64)
	var k [32]byte
	copy(k[:], key)
	var nonce [24]byte
	if _, err := io.ReadFull(crand.Reader, nonce[:]); err != nil {
		t.Fatalf("read nonce: %v", err)
	}
	box := secretbox.Seal(nil, []byte(plaintext), &nonce, &k)
	payload := append(nonce[:], box...)
	return base64.StdEncoding.EncodeToString(payload)
}

func decryptBlob(t *testing.T, keyB64 string, blob []byte) string {
	t.Helper()
	key, _ := base64.RawURLEncoding.DecodeString(keyB64)
	var k [32]byte
	copy(k[:], key)
	if len(blob) < 24 {
		t.Fatalf("blob too short: %d bytes", len(blob))
	}
	var nonce [24]byte
	copy(nonce[:], blob[:24])
	plain, ok := secretbox.Open(nil, blob[24:], &nonce, &k)
	if !ok {
		t.Fatal("decrypt failed")
	}
	return string(plain)
}

func TestEndToEndClaimFlow(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")

	srv, err := server.Start(server.Config{
		SecretNames: []string{"TEST_KEY"},
		Note:        "integration test key",
		TTL:         2 * time.Minute,
		Port:        0,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()

	srvURL := srv.URL()
	if !strings.Contains(srvURL, "/claim/") {
		t.Fatalf("expected /claim/ in URL, got %s", srvURL)
	}

	keyHex, err := token.Generate()
	if err != nil {
		t.Fatal(err)
	}

	client := &http.Client{Timeout: 5 * time.Second}

	// GET form.
	resp, err := client.Get(srvURL)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET form: expected 200, got %d", resp.StatusCode)
	}
	body := readAll(t, resp)
	_ = resp.Body.Close()
	if !strings.Contains(body, "TEST_KEY") {
		t.Fatal("form does not contain secret name")
	}
	t.Log("✓ GET form returns 200 with secret name")

	// POST empty → 400.
	resp, err = client.Post(srvURL, "application/x-www-form-urlencoded", strings.NewReader("value="))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST empty: expected 400, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	t.Log("✓ POST empty returns 400")

	// POST encrypted blob → 200.
	blob := encryptBlob(t, keyHex, `{"TEST_KEY":"sk-test-abc"}`)
	form := neturl.Values{"value": {blob}}
	resp, err = client.Post(srvURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST valid: expected 200, got %d", resp.StatusCode)
	}
	if !strings.Contains(readAll(t, resp), "saved") {
		t.Fatal("success response missing 'saved'")
	}
	_ = resp.Body.Close()
	t.Log("✓ POST encrypted blob returns 200")

	// Wait returns (true, blob).
	ok, encBlob := srv.Wait()
	if !ok {
		t.Fatal("expected Wait to return true")
	}
	t.Log("✓ Wait reports submitted")

	// Decrypt and verify round-trip.
	plaintext := decryptBlob(t, keyHex, encBlob)
	if !strings.Contains(plaintext, "sk-test-abc") {
		t.Fatalf("decrypted value mismatch: got %q", plaintext)
	}
	t.Log("✓ Decrypted value matches original")

	// Write to .env and verify.
	s, err := store.NewEnvStore(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save("TEST_KEY", "sk-test-abc"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `TEST_KEY="sk-test-abc"`) {
		t.Fatalf(".env missing expected value:\n%s", data)
	}
	t.Log("✓ .env contains correct value")
}

func TestBadTokenReturns404(t *testing.T) {
	srv, err := server.Start(server.Config{
		SecretNames: []string{"BAD_TOKEN_TEST"},
		TTL:         2 * time.Minute,
		Port:        0,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()

	badURL := fmt.Sprintf("http://127.0.0.1:%d/claim/invalidtoken123", srv.Port())
	client := &http.Client{Timeout: 3 * time.Second}

	resp, err := client.Get(badURL)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET bad token: expected 404, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	resp, err = client.Post(badURL, "application/x-www-form-urlencoded", strings.NewReader("value=test"))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("POST bad token: expected 404, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	t.Log("✓ Bad token returns 404")
}

func TestTokenReuseBlocked(t *testing.T) {
	srv, err := server.Start(server.Config{
		SecretNames: []string{"REUSE_TEST"},
		TTL:         2 * time.Minute,
		Port:        0,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()

	srvURL := srv.URL()
	client := &http.Client{Timeout: 3 * time.Second}
	keyHex, _ := token.Generate()

	// First claim.
	blob := encryptBlob(t, keyHex, "first")
	form := neturl.Values{"value": {blob}}
	resp, err := client.Post(srvURL, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first claim: expected 200, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	srv.Wait()

	// Second attempt → 404.
	resp, err = client.Post(srvURL, "application/x-www-form-urlencoded", strings.NewReader("value=second"))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("reuse: expected 404, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	t.Log("✓ Token reuse returns 404")
}

func TestBoreTunnelSmoke(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	localPort := ln.Addr().(*net.TCPAddr).Port

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_, _ = io.Copy(conn, conn)
	}()

	tun, err := tunnel.Start(localPort)
	if err != nil {
		t.Skipf("bore.pub unreachable, skipping: %v", err)
	}
	defer tun.Stop()

	if tun.RemotePort() == 0 {
		t.Fatal("expected non-zero remote port from bore.pub")
	}
	t.Logf("✓ bore.pub assigned port %d", tun.RemotePort())
}

func TestBatchClaimFlow(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	names := []string{"KEY_A", "KEY_B", "KEY_C"}

	srv, err := server.Start(server.Config{
		SecretNames: names,
		Note:        "batch test",
		TTL:         2 * time.Minute,
		Port:        0,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()

	// Form contains all three names.
	resp, err := http.Get(srv.URL())
	if err != nil {
		t.Fatal(err)
	}
	body := readAll(t, resp)
	_ = resp.Body.Close()
	for _, n := range names {
		if !strings.Contains(body, n) {
			t.Fatalf("form missing name %q", n)
		}
	}
	t.Log("✓ Form contains all three secret names")

	keyHex, _ := token.Generate()

	// Encrypt JSON with multiple values.
	values := map[string]string{"KEY_A": "val-a", "KEY_B": "val-b", "KEY_C": "val-c"}
	jsonPayload, _ := json.Marshal(values)
	blob := encryptBlob(t, keyHex, string(jsonPayload))

	client := &http.Client{Timeout: 5 * time.Second}
	form := neturl.Values{"value": {blob}}
	resp, err = client.Post(srv.URL(), "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST: expected 200, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()
	t.Log("✓ POST multi-key blob returns 200")

	ok, encBlob := srv.Wait()
	if !ok {
		t.Fatal("expected Wait to return true")
	}

	// Decrypt and validate JSON round-trip.
	plaintext := decryptBlob(t, keyHex, encBlob)
	var got map[string]string
	if err := json.Unmarshal([]byte(plaintext), &got); err != nil {
		t.Fatalf("JSON unmarshal failed: %v\nraw: %q", err, plaintext)
	}
	for k, v := range values {
		if got[k] != v {
			t.Fatalf("key %q: expected %q, got %q", k, v, got[k])
		}
	}
	t.Log("✓ All three values decrypt correctly")

	// Save each to .env and verify.
	s, err := store.NewEnvStore(envPath)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range got {
		if err := s.Save(k, v); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range names {
		expected := fmt.Sprintf(`%s="%s"`, k, values[k])
		if !strings.Contains(string(data), expected) {
			t.Fatalf(".env missing %s:\n%s", expected, data)
		}
	}
	t.Log("✓ .env contains all three key-value pairs")
}

func TestBackwardCompatSingleKey(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")

	srv, err := server.Start(server.Config{
		SecretNames: []string{"LEGACY_KEY"},
		TTL:         2 * time.Minute,
		Port:        0,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()

	keyHex, _ := token.Generate()

	// Encrypt a plain string (old format, no JSON wrapper).
	blob := encryptBlob(t, keyHex, "legacy-value")
	form := neturl.Values{"value": {blob}}
	resp, err := http.Post(srv.URL(), "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST: expected 200, got %d", resp.StatusCode)
	}
	_ = resp.Body.Close()

	ok, encBlob := srv.Wait()
	if !ok {
		t.Fatal("expected Wait to return true")
	}

	plaintext := decryptBlob(t, keyHex, encBlob)
	if plaintext != "legacy-value" {
		t.Fatalf("expected 'legacy-value', got %q", plaintext)
	}

	// Simulate the fallback path: JSON parse fails, use first name.
	var values map[string]string
	if err := json.Unmarshal([]byte(plaintext), &values); err != nil {
		// Fallback: treat as single value for the first name.
		s, err := store.NewEnvStore(envPath)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.Save("LEGACY_KEY", plaintext); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `LEGACY_KEY="legacy-value"`) {
		t.Fatalf(".env missing expected value:\n%s", data)
	}
	t.Log("✓ Legacy plaintext format works")
}

func readAll(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
