# homebridge-powerview

[![npm](https://img.shields.io/npm/v/homebridge-powerview.svg)](https://www.npmjs.com/package/homebridge-powerview)

A [Homebridge](https://github.com/homebridge/homebridge) plugin for [Hunter Douglas PowerView](https://www.hunterdouglas.com/operating-systems/motorized/powerview-motorization) window shades with first-class **Gen 1 hub support**.

Forked from [owenselles/homebridge-powerview-2](https://github.com/owenselles/homebridge-powerview-2) and substantially rewritten to fix reliability issues with Generation 1 hubs.

## What's Different

The original plugin fires concurrent HTTP requests to the PowerView hub. Gen 1 hubs have a tiny embedded webserver that crashes under this load, causing `ECONNRESET` errors, missed automations, and unresponsive shades. This fork fixes that:

- **Serialized request queue** — all requests to the hub are processed one at a time with configurable spacing (default 500ms). No more concurrent request floods.
- **Automatic retries** — transient errors (`ECONNRESET`, timeouts) are retried automatically (configurable, default 2 retries).
- **Command verification** — after sending a shade command, the plugin re-reads the shade position to confirm it actually moved. If not, it retries the command. This fixes the "1-2 shades miss every automation" problem.
- **Request coalescing** — duplicate requests for the same shade are merged automatically, reducing hub load.
- **Zero dependencies** — replaced the deprecated `request` npm package with Node's built-in `http` module.
- **Homebridge 2.0 ready** — updated engine requirements, Node 18+.
- **Config UI X support** — all settings are configurable through the Homebridge UI via `config.schema.json`.

## Supported Shades

- **Roller Shades** — standard up/down control.
- **Horizontal Vanes** (Silhouette, Pirouette) — main accessory controls vertical movement; a tilt slider under Details controls vane angle (0°–90°).
- **Vertical Vanes** (Luminette) — main accessory controls horizontal movement; a tilt slider under Details controls vane angle (-90° to 90°).
- **Top-Down/Bottom-Up** (Duette) — two accessories per shade, one for bottom and one for top, controllable independently or via scenes.

## Installation

1. Install [Homebridge](https://github.com/homebridge/homebridge).
2. Install this plugin:

```bash
npm install -g homebridge-powerview
```

Or install from this repo directly:

```bash
npm install -g git+https://github.com/jlsookiki/homebridge-powerview.git
```

3. Add the platform to your `config.json`:

```json
{
  "platforms": [
    {
      "platform": "PowerView",
      "host": "192.168.1.28"
    }
  ]
}
```

## Configuration

All settings are available through Config UI X, or can be set manually in `config.json`:

| Setting | Default | Description |
|---|---|---|
| `host` | `powerview-hub.local` | Hub IP address or hostname |
| `refreshShades` | `true` | Request fresh positions from shades via RF on each poll |
| `pollShadesForUpdate` | `true` | Periodically poll for shade position changes |
| `pollIntervalMs` | `60000` | How often to poll for updates (ms) |
| `requestIntervalMs` | `500` | Delay between queued hub requests (ms). Gen 1 needs 500+. |
| `requestTimeoutMs` | `10000` | Hub request timeout (ms) |
| `maxRetries` | `2` | Retry attempts for transient errors |
| `verifyCommands` | `true` | Re-read position after commands to confirm execution |
| `verifyDelayMs` | `5000` | Delay before verification read (ms) |

### Shade Type Overrides

If the plugin doesn't recognize your shade type, you can force it:

```json
{
  "platform": "PowerView",
  "host": "192.168.1.28",
  "forceRollerShades": [12345],
  "forceTopBottomShades": [67890],
  "forceHorizontalShades": [11111],
  "forceVerticalShades": [22222]
}
```

### Gen 1 Hub Tuning

If you're still seeing occasional errors with a Gen 1 hub, try increasing the request spacing:

```json
{
  "platform": "PowerView",
  "host": "192.168.1.28",
  "requestIntervalMs": 750,
  "pollIntervalMs": 120000,
  "maxRetries": 3
}
```

## How It Works

### Request Queue

Every request to the hub (GET, PUT, refresh) goes through a serial queue. Only one request is in-flight at a time. The queue automatically:

- **Spaces requests** by `requestIntervalMs` (default 500ms)
- **Coalesces duplicates** — if HomeKit polls 9 shades at once, and shade #5 is already queued, the second request piggybacks on the first
- **Merges PUT commands** — if two position changes arrive for the same shade before the first is sent, they're combined into a single request
- **Retries on failure** — `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, and `EPIPE` errors trigger automatic retry with a 2-second backoff

### Command Verification

When `verifyCommands` is enabled (default), after every SET command the plugin waits `verifyDelayMs` (default 5s), then reads the shade's actual position. If the shade didn't move to within 5% of the target, the command is automatically retried. This catches the cases where the hub acknowledged the command but the shade didn't respond (common with Gen 1 hubs under load or shades at the edge of RF range).

## Changelog

### 2.0.0

- Rewrote `PowerViewHub.js`: all requests serialized through queue, native `http` module (zero dependencies), automatic retries with backoff
- Rewrote `index.js`: ES6 classes, command verification, configurable poll intervals, cleaner characteristic management
- Added `config.schema.json` for Config UI X support
- Removed deprecated `request` npm dependency
- Updated engine requirements: Node 18+, Homebridge 1.6+

### 1.0.9

- Last release of owenselles/homebridge-powerview-2

## License

ISC
