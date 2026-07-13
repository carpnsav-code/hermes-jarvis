# Getting a website link for the Jarvis voice page

The Jarvis page (`/jarvis` in the web dashboard) is served by the same
FastAPI server as the rest of the dashboard and talks to the agent over
the `/api/ws` JSON-RPC gateway. To reach it from a browser you need that
server running somewhere, and — for voice — an HTTPS (or localhost) URL,
because browsers only allow the microphone and speech APIs in secure
contexts.

## Option 1 — local link (same machine)

```bash
cd web && npm install && npm run build   # once, after pulling the branch
hermes dashboard
```

Open **http://localhost:9119/jarvis**. Mic and text-to-speech both work
(localhost counts as a secure context). No auth is required on a
loopback bind.

## Option 2 — public link from anywhere (VPS or always-on PC)

Any non-loopback bind engages the dashboard's login gate, which needs an
auth provider. The zero-infrastructure one is the bundled username +
password provider — configure it in `config.yaml`:

```yaml
dashboard:
  basic_auth:
    username: admin
    password: "pick-a-long-password"     # or password_hash (scrypt), preferred
    secret: "<32+ random bytes, base64>" # optional: sessions survive restarts
```

(Env overrides exist: `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` /
`..._PASSWORD` / `..._PASSWORD_HASH` / `..._SECRET`.)

Then bind publicly:

```bash
hermes dashboard --host 0.0.0.0 --port 9119 --no-open
```

Finally put HTTPS in front so the mic works. Easiest options:

- **Cloudflare quick tunnel** (instant URL, no domain needed):

  ```bash
  cloudflared tunnel --url http://<server-ip>:9119
  ```

  This prints an `https://….trycloudflare.com` link — open
  `https://…/jarvis` and log in.

- **Caddy with your own domain** (stable URL):

  ```
  jarvis.example.com {
      reverse_proxy 127.0.0.1:9119
  }
  ```

- **Tailscale** (private to your devices): `tailscale serve 9119`, then
  use the `https://<machine>.<tailnet>.ts.net/jarvis` URL.

> **Warning — do not tunnel straight to a loopback bind.** The auth gate
> keys off the *bind* host: `127.0.0.1` is treated as a trusted local
> operator and gets **no login page**. A public tunnel forwarding to a
> loopback bind therefore hands full agent control to anyone with the
> URL. When exposing through a tunnel, either bind `0.0.0.0` (gate + 
> password engage, as above) or use a tunnel that adds its own
> authentication (Cloudflare Access, Tailscale).

## Browser support for voice

- **Chrome / Edge**: mic input (SpeechRecognition) and read-aloud both work.
- **Safari**: both work (WebKit speech APIs).
- **Firefox**: read-aloud works; mic input is not supported — the Chat
  tab's text composer is the fallback and replies are still spoken.
