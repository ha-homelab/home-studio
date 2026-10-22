# Vacuum position overlays

Home Studio can place a small robot marker on a calibrated floor without adding
3D geometry, texture downloads, or a polling loop. The marker follows the camera
when the plan is rotated. Selecting it opens the vacuum's Home Assistant details;
it never starts, stops, or redirects cleaning.

This is an advanced **compiled-model binding**, not an automatic map importer or
a calibration tool in the drawing editor. Your Home Assistant integration must
provide coordinates separately. Ordinary vacuum state and battery entities do
not establish a physical position.

## Prepare a source

Create or use a sensor with numeric native-map `x` and `y`, a stable `map_id`,
and an explicit source timestamp. The successful sensor state may be `available`
or `reported`; errors should make it `unavailable`. Do not advance the original
timestamp when a read fails. An explicit `valid: false` also invalidates a report.

When the device supplies a real observation time, use `observed_at` as an ISO 8601
string with a timezone. When it only returns cached coordinates, use this honest
alternative:

```json
{
  "x": 1200,
  "y": 3400,
  "map_id": "upstairs",
  "observed_at": null,
  "retrieved_at": "2026-01-01T12:00:00.123456+00:00",
  "timestamp_quality": "not_provided"
}
```

A retrieval time means **when Home Assistant read the value**, not when the robot
was at that position. The overlay calls it **Reported position**, says
**Observation time unavailable**, and labels its age **Retrieved**. It never uses
Home Assistant's generic `last_updated` as a substitute observation time.

## Bind a floor

Add `vacuum_sources` to the compiled model. This fictional example converts native
millimetre coordinates into floor metres; replace the transform with your own
measured registration:

```json
{
  "vacuum_sources": [{
    "id": "upstairs_robot",
    "name": "Upstairs vacuum",
    "entity_id": "vacuum.upstairs",
    "position_entity_id": "sensor.upstairs_position",
    "floor_id": "upstairs",
    "map_id": "upstairs",
    "transform": [0.001, 0, 0, 0, 0.001, 0],
    "bounds": [0, 0, 12, 10],
    "max_age_seconds": 120,
    "calibration": "approximate"
  }]
}
```

`floor_id` must equal the model's `floor`, not its project `id`. The six transform
numbers `[a,b,c,d,e,f]` mean `floorX = a*x + b*y + c` and
`floorZ = d*x + e*y + f`. Bounds are `[minimumX, minimumZ, maximumX, maximumZ]` in
metres. A singular transform is rejected. Map IDs must match in both value and
type. Keep `calibration: "approximate"` unless the alignment has been measured.

Match several fixed, well-separated features such as wall junctions. Check the
whole floor, not just the charging dock. A cleaning segment can span multiple
architectural rooms, so segment labels alone are not a calibration. Revalidate
after any vendor map reset or floor alignment change. Do not reuse relative
odometry from another robot without a separate registration.

## Freshness and failure behaviour

- No valid, calibrated initial sample: no marker.
- Successful coordinate report: a marker with state, optional battery, age, and
  calibration notice in its accessible tooltip.
- Expired sample, unavailable sensor, or disconnected HA: retain only a previously
  accepted position and visibly label it **Last known**.
- A report identifying a different map: remove the old marker rather than drawing
  another floor's position here.
- Invalid numbers, dates, future timestamps, and positions outside the configured
  bounds are rejected. A timestamp cannot silently acquire new coordinates.

Last-known state is in memory only. Reloading does not turn an old cached point
into fresh evidence. The implementation admits at most 32 bindings per floor,
uses screen-space SVG, updates visible age labels with one timer, and stops that
timer when hidden or disposed. It adds no WebGL mesh or continuous render loop.

## Data and permissions

The host reads bindings from the server's installed model, not from an iframe's
claim. Both the robot and source sensor must be readable by the current HA user.
Only validated coordinates and timestamp provenance cross the viewer bridge;
raw sensor attributes and credentials do not. Standalone hosting reuses the same
panel and projection code. Household maps and transforms belong in your private
model, never in a public release example.

## Troubleshooting

**No marker:** confirm the successful sensor state, numeric coordinates, explicit
timestamp provenance, exact map ID, model floor name, transform, bounds, and HA
read permissions. An unavailable source at startup intentionally shows nothing.

**Marker in the wrong place:** check native units, axis order, sign, and offsets.
Do not compensate by extending bounds until a bad transformation looks valid.

**Last known while the robot is running:** inspect the coordinate sensor itself.
A working vacuum entity does not guarantee that its map position is updating.
