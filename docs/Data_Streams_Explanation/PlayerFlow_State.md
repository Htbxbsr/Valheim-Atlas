# PlayerFlow State (Aggregator)

PlayerFlow is derived from **zone-to-zone transitions** reported by the plugin.
It is anonymous (no player identity in the stream) and aggregated by directed edges.

## Stream: `player_flow`

The plugin emits transitions per bucket:

```
{
  "type": "player_flow",
  "t": "<ISO-8601 UTC>",
  "bucket_s": <int>,
  "transitions": [
    { "fx": <int>, "fy": <int>, "tx": <int>, "ty": <int>, "n": <int> }
  ]
}
```

## Aggregator Semantics

- Edge key is **directed**: `(fx, fy) -> (tx, ty)`.
- Counts are **additive** within a bucket.
- TTL is **frames-based** (10 emitted frames):
  - If an edge is updated in the current bucket, TTL resets to 10.
  - If not updated, TTL is decremented by 1 each emitted frame.
  - When TTL reaches 0, the edge is removed.
- Intensity (`c`) persists as the last known count while TTL > 0.

## Frame Output

Every emitted frame includes active flow edges:

```
{
  "flow": [
    { "a": { "zx": <int>, "zy": <int> }, "b": { "zx": <int>, "zy": <int> }, "c": <int> }
  ]
}
```

## Viewer Notes

- The viewer renders whatever edges exist in the frame.
- It aggregates a short window of recent frames (N=5) for display.
- The viewer does **not** apply TTL; it relies on frame contents.

## Manual Regression Checklist

1) A new transition appears in the next emitted frame.
2) With no further updates, the edge disappears after 10 frames.
3) If updates resume, the edge count refreshes and TTL resets.
