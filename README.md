# savvy-ai

Two projects, one repo.

| Folder | What it is |
|---|---|
| [`camofox/`](camofox/) | The camofox-browser server — Camoufox driven over REST. Fork of [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser). Start here: [camofox/README.md](camofox/README.md). |
| [`ezlynx-agent/`](ezlynx-agent/) | EZLynx Auto + Home quoting agent. Drives camofox over REST to fill and submit comparative-rater quotes. See [ezlynx-agent/README.md](ezlynx-agent/README.md). |

The agent talks to the server over HTTP, so run camofox first:

```bash
cd camofox && npm install && npm start
```

then, in another terminal:

```bash
cd ezlynx-agent && npm install && npm run build && node --env-file=.env dist/src/cli.js login --check
```
