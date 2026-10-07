# Pocket Option OTC read-only feed bridge

This small local process reads OTC tick streams through the community
[`PocketOptionApi`](https://github.com/chema-creator/PocketOptionApi) library
and forwards them to the bot's shadow collector. It subscribes to the five
OTC pairs the bot already tracks, using 30-second chart subscriptions. It
does not call any order placement method.

The library is unofficial and can stop working if Pocket Option changes its
private WebSocket protocol. The SSID is an account credential. Use a demo
account, keep the SSID only in a local environment variable, and never put it
in this repository or in chat.

## Install

Use Python 3.10 or newer. In this directory, create an isolated environment
and install the community library:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Configure

In Cloudflare, add the Worker secret `POCKETOPTION_FEED_SECRET`. Set it to a
long random value and use the exact same value locally as
`PO_FEED_INGEST_SECRET`. The Worker accepts only authenticated HTTPS batches.

Set the three local variables in PowerShell (do not paste the SSID into a
tracked file):

```powershell
$env:PO_SSID = '42["auth",{...}]'
$env:PO_FEED_INGEST_URL = 'https://YOUR-WORKER.workers.dev/pocketoption-feed'
$env:PO_FEED_INGEST_SECRET = 'the-same-random-value-configured-in-cloudflare'
```

The SSID shown above is a placeholder. Obtain the complete demo-session
payload from your own Pocket Option browser session; do not send it to anyone.

## Run

```powershell
python .\bridge.py
```

Keep the process running while collecting data. The local computer must stay
online. Check `/shortdiag` in the bot to confirm the Worker is receiving
fresh 30-second OTC bars. Stop with Ctrl+C.
