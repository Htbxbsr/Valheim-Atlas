# Valheim Atlas

> Independent, unofficial project.  
> Not affiliated with, endorsed by, or supported by Iron Gate AB or Valheim.  
> This tool does not modify gameplay and is not an MMO framework.
>
> “Valheim” is a registered trademark of Iron Gate AB.

---

## Overview

Valheim Atlas is a **read-only analysis and visualization tool** for Valheim servers.

It helps server operators understand how their world is actually used over time:
where players concentrate, how movement flows across the map,
and how persistent world load evolves as the server grows.

Valheim Atlas does **not** change gameplay, balance, mechanics, or progression.
It only observes, aggregates, and visualizes server-side data.

---

## Use Case

Valheim Atlas is designed for **server administrators and operators** who want
long-term visibility into world activity and load patterns.

Typical questions Valheim Atlas helps answer:

- Where do players concentrate during peak hours?
- Which areas of the world accumulate high ZDO density?
- How does player movement flow between regions?
- How does world load evolve over days or weeks?
- Are there emerging hotspots caused by building or activity clustering?

The tool is especially useful for:
- Persistent or long-running servers
- Community build worlds
- Performance and stability observation
- Historical analysis (without wipes)

---

## System Architecture

Valheim Atlas consists of three components that form a simple, one-directional pipeline:

1. **Server Plugin**  
   A lightweight BepInEx plugin emits telemetry data from the Valheim server.

2. **Aggregator**  
   A Python-based process aggregates raw events into time-based frames
   and prepares them for visualization.

3. **Static Web Viewer**  
   A browser-based viewer renders maps, overlays, and timelines
   from the aggregated data.

Data always flows in one direction:

Valheim Server → Plugin → Aggregator → Static Viewer


There is no live server interaction and no client-side dependency.

---

## Plugin Installation (BepInEx)

The Valheim Atlas plugin is distributed as a **prebuilt DLL via GitHub Releases**.

### Installation

1. Download the latest plugin DLL from the GitHub Releases page
2. Place the DLL into:

BepInEx/plugins/

3. Restart the Valheim server

The plugin:
- has no in-game UI
- does not affect gameplay
- only emits telemetry data

---

## Aggregator

The aggregator is a Python script that:
- reads emitted telemetry data
- groups events into time buckets
- produces frame-based JSON outputs
- maintains lightweight health and state metadata

It is designed to:
- run alongside the server
- fail safely (no hard crashes)
- regenerate derived data from existing frames

See:
 `docs/Data_Streams_Explanation/Aggregator_Explanation.md`
 `docs/DEBUG_RUNBOOK.md`

## Aggregator Input Configuration

By default, the Valheim Atlas aggregator expects its input data in a local
`input/` directory relative to its working directory.

However, the Valheim Atlas server plugin writes telemetry data to the following
location by default:

BepInEx/config/heatflow/

This means one of the following setups is required at startup:

Option 1: Pass input directory explicitly (recommended)

Run the aggregator with an explicit input path pointing to the plugin output:

python aggregator.py --input /path/to/Valheim/BepInEx/config/heatflow

Option 2: Symlink or copy data into input/

Create a symlink or periodically copy the plugin output directory
into the aggregator's expected `input/` directory.

ln -s /path/to/Valheim/BepInEx/config/heatflow ./input

The aggregator does not modify input data.
It only reads and aggregates existing telemetry files.
---

## Viewer

The viewer is a **static web application** (HTML + JavaScript).

It supports:
- live and historical playback
- heatmaps and activity overlays
- time-based navigation
- layered visualization modes

No backend server is required.
Opening `index.html` in a browser is sufficient.

### Viewer Controls

The viewer allows inspection of server activity using:
- timeline controls
- overlay toggles
- map layers
- density and flow visualizations

---

## Repository Scope

This repository contains:
- Aggregator scripts
- Static web viewer
- System and data format documentation

The **plugin binary** is distributed via GitHub Releases.
The repository does **not** include:
- Valheim binaries
- Unity assemblies
- BepInEx dependencies
- runtime telemetry data

---

## Data Formats (Reference)

The following documents describe internal data formats and states.
They are intended for **advanced users and developers**:

- Player positions
- Player flow states
- Hotspot states
- Performance maps
- World and map metadata

See the `docs/` directory for detailed specifications.

---

## Non-Goals

Valheim Atlas explicitly does **not** aim to be:
- an MMO framework
- a gameplay modification
- a server replacement
- a performance optimization mod
- a live admin control tool

Its sole purpose is **observation and visualization**.

---

## License

This project is licensed under a custom non-resale license.

Commercial server usage is allowed.  
Redistribution or resale of the software itself is prohibited.

See `LICENSE` for details.

---

## Disclaimer

This is an independent, community-driven project.
No official support or guarantees are provided.
Use at your own risk.

