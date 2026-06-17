package cmd

import (
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/rubybear-lgtm/pinchpass/server"
	"github.com/rubybear-lgtm/pinchpass/store"
	"github.com/rubybear-lgtm/pinchpass/token"
	"github.com/rubybear-lgtm/pinchpass/tunnel"
	"golang.org/x/crypto/nacl/secretbox"
)

// RequestConfig holds parsed CLI flags for the "request" command.
type RequestConfig struct {
	SecretNames []string
	Note        string
	Port        int
	TTLMinutes  int
	ListenAddr  string
	OutFile     string
	JSONOutput  bool
	Tunnel      bool
	GenOnly     bool
}

// RequestOutput is the JSON-serializable result printed after completion.
type RequestOutput struct {
	Success bool     `json:"success"`
	Names   []string `json:"names"`
	Message string   `json:"message"`
	URL     string   `json:"url"`
	Port    int      `json:"port"`
}

// RunRequest executes the "pinchpass request <name>" subcommand.
func RunRequest(args []string) error {
	cfg, err := parseRequestFlags(args)
	if err != nil {
		return err
	}

	s, err := store.NewEnvStore(cfg.OutFile)
	if err != nil {
		return fmt.Errorf("store: %w", err)
	}

	encKeyStr, err := token.Generate()
	if err != nil {
		return fmt.Errorf("generate key: %w", err)
	}
	keyBytes, _ := base64.RawURLEncoding.DecodeString(encKeyStr)

	srv, err := server.Start(server.Config{
		SecretNames: cfg.SecretNames,
		Note:        cfg.Note,
		TTL:         time.Duration(cfg.TTLMinutes) * time.Minute,
		Port:        cfg.Port,
		ListenAddr:  cfg.ListenAddr,
	})
	if err != nil {
		return fmt.Errorf("start server: %w", err)
	}

	url := fmt.Sprintf("http://127.0.0.1:%d/claim/%s#k=%s", srv.Port(), srv.Path(), encKeyStr)

	if cfg.Tunnel {
		tun, err := tunnel.Start(srv.Port())
		if err != nil {
			return fmt.Errorf("bore tunnel: %w", err)
		}
		defer tun.Stop()
		url = fmt.Sprintf("http://bore.pub:%d/claim/%s#k=%s", tun.RemotePort(), srv.Path(), encKeyStr)
	}

	if cfg.JSONOutput {
		out := RequestOutput{
			Success: true,
			Names:   cfg.SecretNames,
			Message: fmt.Sprintf("Secret request link (one-time, expires in %d min)", cfg.TTLMinutes),
			URL:     url,
			Port:    srv.Port(),
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(out)
	} else {
		tunnelNote := ""
		if cfg.Tunnel {
			tunnelNote = " via bore.pub"
		}
		fmt.Println()
		fmt.Printf("  🔗  Secret request link (one-time, E2E encrypted%s)\n", tunnelNote)
		fmt.Println()
		fmt.Printf("     %s\n", url)
		fmt.Println()
		for _, n := range cfg.SecretNames {
			fmt.Printf("     Name:   %s\n", n)
		}
		if cfg.Note != "" {
			fmt.Printf("     Note:   %s\n", cfg.Note)
		}
		fmt.Printf("     Expiry: %d minutes\n", cfg.TTLMinutes)
		fmt.Println()
		fmt.Println("     Waiting for user to submit...")
		fmt.Println()
	}

	ok, encBlob := srv.Wait()

	if ok {
		plain, err := decryptBlob(keyBytes, encBlob)
		if err != nil {
			return fmt.Errorf("decrypt: %w", err)
		}
		if err := saveSecret(s, cfg.SecretNames, plain); err != nil {
			return err
		}
	}

	if cfg.JSONOutput {
		out := RequestOutput{
			Success: ok,
			Names:   cfg.SecretNames,
			Port:    srv.Port(),
		}
		if ok {
			out.Message = "Secrets provisioned successfully."
		} else {
			out.Message = "Request timed out or failed."
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(out)
	} else {
		if ok {
			fmt.Println()
			fmt.Printf("  ✅  Saved to %s\n", cfg.OutFile)
			for _, n := range cfg.SecretNames {
				fmt.Printf("       %s\n", n)
			}
			fmt.Println()
		} else {
			fmt.Println()
			fmt.Println("  ❌  Request timed out. No secret was saved.")
			fmt.Println()
			os.Exit(1)
		}
	}

	return nil
}

// saveSecret decrypts a JSON blob or falls back to a single key, then saves each key-value pair.
func saveSecret(s store.Store, names []string, plain string) error {
	var values map[string]string
	if err := json.Unmarshal([]byte(plain), &values); err == nil {
		for k, v := range values {
			if err := s.Save(k, v); err != nil {
				return fmt.Errorf("save %s: %w", k, err)
			}
		}
		return nil
	}
	// Fallback: treat as single value for the first name.
	if len(names) == 0 {
		return nil
	}
	return s.Save(names[0], plain)
}

// decryptBlob decrypts a nacl/secretbox payload (nonce[24] || mac+ciphertext).
func decryptBlob(key, blob []byte) (string, error) {
	if len(blob) < 24+secretbox.Overhead {
		return "", fmt.Errorf("blob too short (%d bytes)", len(blob))
	}
	var nonce [24]byte
	copy(nonce[:], blob[:24])
	var k [32]byte
	copy(k[:], key)
	plain, ok := secretbox.Open(nil, blob[24:], &nonce, &k)
	if !ok {
		return "", fmt.Errorf("decryption failed (tampered payload?)")
	}
	return string(plain), nil
}

func parseRequestFlags(args []string) (*RequestConfig, error) {
	var secretNames []string
	var flagArgs []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if strings.HasPrefix(arg, "-") {
			flagArgs = append(flagArgs, arg)
			if isValueFlag(arg) && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
				flagArgs = append(flagArgs, args[i])
			}
		} else {
			secretNames = append(secretNames, arg)
		}
	}

	fs := flag.NewFlagSet("request", flag.ContinueOnError)
	cfg := &RequestConfig{}
	fs.StringVar(&cfg.Note, "note", "", "Human-readable description shown on the form")
	fs.IntVar(&cfg.Port, "port", 0, "Port to bind (default: random available)")
	fs.IntVar(&cfg.TTLMinutes, "ttl", 30, "Minutes until the link expires")
	fs.StringVar(&cfg.ListenAddr, "listen-addr", "127.0.0.1", "Address to listen on")
	fs.StringVar(&cfg.OutFile, "out", ".env", "Output .env file path")
	fs.BoolVar(&cfg.JSONOutput, "json", false, "Output as JSON for agent parsing")
	fs.BoolVar(&cfg.Tunnel, "tunnel", false, "Open a bore.pub tunnel and print the public URL")

	if err := fs.Parse(flagArgs); err != nil {
		return nil, err
	}
	if len(secretNames) == 0 {
		return nil, fmt.Errorf("usage: pinchpass request <secret-name>... [flags]\n\nRun 'pinchpass --help' for available flags")
	}
	cfg.SecretNames = secretNames
	return cfg, nil
}

func isValueFlag(arg string) bool {
	name := strings.TrimLeft(arg, "-")
	switch name {
	case "note", "port", "ttl", "listen-addr", "out":
		return true
	default:
		return false
	}
}
