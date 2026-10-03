# Disaster Terrain Simulator (3D)

An interactive 3D simulation of eight natural disasters on procedurally generated terrain, with unconscious survivors scattered across the terrain who need outside help. Built for Smart India Hackathon (SIH).

## Disaster modes

| Key | Mode | What happens |
|-----|------|--------------|
| 1 | Earthquake | Cycles of shaking, tilted and collapsed buildings, ground fissure, falling debris, dust |
| 2 | Flood | Rising river water, people stranded on rooftops, rescue boats, helicopter, rain |
| 3 | Wildfire | Fire front sweeping through forest, burnt trees, smoke, fire trucks, water helicopter |
| 4 | Tornado | Rotating funnel with debris, storm cloud, roofs torn off, trees knocked down |
| 5 | Volcano | Ash column, lava bombs, glowing lava flows moving downhill |
| 6 | Tsunami | Sea draws back, wave surges ashore with foam and floods the coast |
| 7 | Landslide | Boulders and mud sliding down a mountain channel into town |
| 8 | Blizzard | Heavy wind-driven snow, low visibility, snowplow, stuck car |

Each mode shows a live status line and a real-world safety tip.

## Survivors

- In every mode, unconscious survivors are scattered across the whole terrain: in town, in the fields, on hillsides and along coasts or riverbanks.
- Each survivor is marked by a floating red diamond and a pulsing red ring, showing they need help from outside.
- Placement avoids water, lava craters, building interiors and very steep slopes, and survivors are spaced apart so they don't cluster.
- The panel shows how many unconscious survivors are on the map.

## How to run

The project works offline; no install or build step is needed.

- Easiest: double-click `index.html` to open it in Chrome, Edge or Firefox.
- If your browser blocks local files, serve the folder:
  ```bash
  python -m http.server 8000
  ```
  then open http://localhost:8000

## Controls

- Drag: rotate the view
- Scroll or pinch: zoom
- Keys 1–8 or the bottom bar: switch disaster
- Intensity slider: make the disaster weaker or stronger
- Buttons: show/hide survivors, auto-rotate, pause, reset view

## Tech stack

HTML5 + CSS3 + JavaScript + **Three.js r128** (WebGL). Terrain is generated in code with a noise function; there are no external 3D model files.

## Project structure

```
disaster-terrain-3d/
├── index.html          Page layout and on-screen panels
├── css/style.css       Styling (light and dark themes, mobile layout)
├── js/main.js          3D scene, terrain, disasters, people and controls
├── libs/three.min.js   Three.js library (bundled for offline use)
├── libs/THREE-LICENSE.txt
└── README.md
```

## Credits

Three.js is © the three.js authors, MIT License (see `libs/THREE-LICENSE.txt`).
