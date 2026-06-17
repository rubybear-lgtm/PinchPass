package tunnel

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
)

const (
	boreHost = "bore.pub"
	borePort = 7835
)

// Tunnel manages a bore.pub tunnel forwarding to a local port.
type Tunnel struct {
	localPort  int
	remotePort int
	ctrl       net.Conn
	stopOnce   sync.Once
	stopCh     chan struct{}
}

// Start dials bore.pub, completes the handshake, and begins proxying.
// Returns once the remote port is known.
func Start(localPort int) (*Tunnel, error) {
	ctrl, err := net.Dial("tcp", net.JoinHostPort(boreHost, strconv.Itoa(borePort)))
	if err != nil {
		return nil, fmt.Errorf("dial bore.pub: %w", err)
	}

	br := bufio.NewReader(ctrl)

	if err := sendMsg(ctrl, map[string]uint16{"Hello": 0}); err != nil {
		_ = ctrl.Close()
		return nil, fmt.Errorf("send hello: %w", err)
	}

	remotePort, err := recvHello(br)
	if err != nil {
		_ = ctrl.Close()
		return nil, fmt.Errorf("recv hello: %w", err)
	}

	t := &Tunnel{
		localPort:  localPort,
		remotePort: remotePort,
		ctrl:       ctrl,
		stopCh:     make(chan struct{}),
	}
	go t.loop(br)
	return t, nil
}

// RemotePort returns the bore.pub-assigned public port.
func (t *Tunnel) RemotePort() int { return t.remotePort }

// Stop shuts down the tunnel.
func (t *Tunnel) Stop() {
	t.stopOnce.Do(func() {
		close(t.stopCh)
		_ = t.ctrl.Close()
	})
}

func (t *Tunnel) loop(br *bufio.Reader) {
	defer t.Stop()
	for {
		msg, err := recvServerMsg(br)
		if err != nil {
			return
		}
		switch v := msg.(type) {
		case connMsg:
			go t.proxy(v.id)
		case heartbeatMsg:
			// ignore
		case errMsg:
			return
		}
	}
}

func (t *Tunnel) proxy(id string) {
	remote, err := net.Dial("tcp", net.JoinHostPort(boreHost, strconv.Itoa(borePort)))
	if err != nil {
		return
	}
	defer func() { _ = remote.Close() }()

	br := bufio.NewReader(remote)

	if err := sendMsg(remote, map[string]string{"Accept": id}); err != nil {
		return
	}

	local, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", t.localPort))
	if err != nil {
		return
	}
	defer func() { _ = local.Close() }()

	// Drain bytes buffered by bufio after the JSON framing exchange.
	if n := br.Buffered(); n > 0 {
		buf := make([]byte, n)
		_, _ = br.Read(buf)
		_, _ = local.Write(buf)
	}

	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(local, remote); done <- struct{}{} }()
	go func() { _, _ = io.Copy(remote, local); done <- struct{}{} }()
	select {
	case <-done:
	case <-t.stopCh:
	}
}

// Message types returned by recvServerMsg.
type heartbeatMsg struct{}
type connMsg struct{ id string }
type errMsg struct{ text string }

func recvServerMsg(br *bufio.Reader) (interface{}, error) {
	line, err := br.ReadBytes(0)
	if err != nil {
		return nil, err
	}
	line = line[:len(line)-1]

	// Bare string variants like "Heartbeat".
	var s string
	if json.Unmarshal(line, &s) == nil {
		return heartbeatMsg{}, nil
	}

	var obj map[string]json.RawMessage
	if err := json.Unmarshal(line, &obj); err != nil {
		return nil, fmt.Errorf("malformed message: %w", err)
	}
	if raw, ok := obj["Connection"]; ok {
		var id string
		if err := json.Unmarshal(raw, &id); err != nil {
			return nil, err
		}
		return connMsg{id}, nil
	}
	if raw, ok := obj["Error"]; ok {
		var msg string
		_ = json.Unmarshal(raw, &msg)
		return errMsg{msg}, nil
	}
	return heartbeatMsg{}, nil
}

func recvHello(br *bufio.Reader) (int, error) {
	line, err := br.ReadBytes(0)
	if err != nil {
		return 0, err
	}
	line = line[:len(line)-1]

	var obj map[string]json.RawMessage
	if err := json.Unmarshal(line, &obj); err != nil {
		return 0, fmt.Errorf("expected Hello: %w", err)
	}
	if raw, ok := obj["Error"]; ok {
		var msg string
		_ = json.Unmarshal(raw, &msg)
		return 0, fmt.Errorf("server error: %s", msg)
	}
	raw, ok := obj["Hello"]
	if !ok {
		return 0, fmt.Errorf("expected Hello, got: %s", line)
	}
	var port uint16
	if err := json.Unmarshal(raw, &port); err != nil {
		return 0, err
	}
	return int(port), nil
}

func sendMsg(conn net.Conn, v interface{}) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = conn.Write(append(b, 0))
	return err
}
