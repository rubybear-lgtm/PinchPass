package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/rubybear-lgtm/pinchpass/cmd"
)

const usage = `pinchpass — one-time secret request link

Usage:
  pinchpass request <secret-name>... [flags]

Commands:
  request   Generate a one-time link to collect one or more secrets from the user

Global Flags:
  -out <path>        Output .env file path (default: .env)
  -note <text>       Human-readable description shown on the form
  -port <num>        Port to bind (default: random)
  -ttl <minutes>     Minutes until link expires (default: 30)
  -listen-addr <ip>  Address to listen on (default: 127.0.0.1)
  -json              Output as JSON for agent parsing
  -tunnel            Open a bore.pub tunnel for public URL access

Examples:
  pinchpass request API_KEY -note "Production API key"
  pinchpass request DB_HOST DB_PORT DB_NAME -out .env
  pinchpass request WEBHOOK_SECRET -out config/secrets.env -json
  pinchpass request DATABASE_URL -port 9999 -ttl 15
`

func main() {
	if len(os.Args) < 2 || os.Args[1] == "--help" || os.Args[1] == "-h" {
		fmt.Print(usage)
		return
	}

	switch os.Args[1] {
	case "request":
		if err := cmd.RunRequest(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
			os.Exit(1)
		}
	default:
		// Support directly invoking as "pinchpass <name>" without "request" subcommand.
		if !strings.HasPrefix(os.Args[1], "-") {
			// Treat bare name as "request <name>"
			if err := cmd.RunRequest(os.Args[1:]); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %s\n", err)
				os.Exit(1)
			}
		} else {
			fmt.Fprintf(os.Stderr, "Unknown command: %s\n", os.Args[1])
			fmt.Print(usage)
			os.Exit(1)
		}
	}
}
